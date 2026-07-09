const fs = require('fs');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const DRY_RUN = process.env.CMPA_PAUTAS_DRY_RUN === '1' || process.argv.includes('--dry-run');
const ARQUIVO_ESTADO = 'estado_pautas.json';
const LOOKAHEAD_DIAS = Number(process.env.CMPA_PAUTAS_LOOKAHEAD_DIAS || 14);
const BASE = 'https://www.camarapoa.rs.gov.br';
const TRANSPARENCIA = 'https://transparencia.camarapoa.rs.gov.br';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { pautas_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function html(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDataBR(valor) {
  const m = String(valor || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
}

function formatarData(data) {
  if (!data) return '-';
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dentroDaJanela(data) {
  if (!data) return false;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + LOOKAHEAD_DIAS);
  limite.setHours(23, 59, 59, 999);
  return data >= hoje && data <= limite;
}

async function get(url) {
  const resp = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'MonitorLegislativo-RadarCMPA/1.0 (+contato: tramitacao@monitorlegislativo.com.br)'
    }
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' em ' + url);
  return resp.text();
}

function absoluto(href, base) {
  if (!href) return '';
  return new URL(href, base).toString();
}

async function buscarComissoes() {
  const url = TRANSPARENCIA + '/interesse_coletivo/pautas/de_reunioes_de_comissoes?data=futuras';
  const $ = cheerio.load(await get(url));
  const itens = [];
  $('table tbody tr').each(function () {
    const tds = $(this).find('td');
    const dataTexto = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const data = parseDataBR(dataTexto);
    if (!dentroDaJanela(data)) return;
    const a = $(tds[1]).find('a').first();
    const titulo = a.text().replace(/\s+/g, ' ').trim() || $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const descricao = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    const proponente = $(tds[3]).text().replace(/\s+/g, ' ').trim();
    const urlItem = absoluto(a.attr('href'), TRANSPARENCIA);
    const id = (urlItem.match(/reunioes_de_comissoes\/(\d+)/) || [null, dataTexto + '-' + titulo])[1];
    itens.push({
      id: 'comissao-' + id,
      origem: 'Comissão/Audiência',
      data,
      dataTexto: formatarData(data),
      titulo,
      descricao,
      proponente,
      url: urlItem
    });
  });
  return itens;
}

async function buscarPlenario() {
  const $ = cheerio.load(await get(BASE + '/sessoes_plenarias'));
  const itens = [];
  const vistos = new Set();
  $('section.ui.relaxed.divided.items article.item').each(function () {
    const article = $(this);
    const a = article.find('a[href^="/sessoes_plenarias/"]').first();
    const href = a.attr('href');
    const url = absoluto(href, BASE);
    const id = (url.match(/sessoes_plenarias\/(\d+)/) || [null, ''])[1];
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    const around = article.find('.description').text().replace(/\s+/g, ' ').trim();
    const data = parseDataBR(around);
    if (!dentroDaJanela(data)) return;
    itens.push({
      id: 'plenario-' + id,
      origem: 'Plenário',
      data,
      dataTexto: formatarData(data),
      titulo: around || ('Sessão Plenária ' + id),
      descricao: 'Sessão plenária/Ordem do Dia. O detalhe pode conter itens legislativos para Pauta Analisada.',
      proponente: 'CMPA',
      url
    });
  });
  return itens;
}

async function buscarNoticiasInstitucionais() {
  const url = BASE + '/noticias/institucionais';
  const $ = cheerio.load(await get(url));
  const itens = [];
  const vistos = new Set();
  $('article.item, .ui.items .item, .news-item, .noticia, main a[href^="/noticias/"]').each(function () {
    const bloco = $(this);
    const a = bloco.is('a') ? bloco : bloco.find('a[href^="/noticias/"]').first();
    const href = a.attr('href');
    const urlItem = absoluto(href, BASE);
    if (!urlItem || vistos.has(urlItem)) return;
    vistos.add(urlItem);
    const titulo = a.text().replace(/\s+/g, ' ').trim() || bloco.find('.header,h2,h3').first().text().replace(/\s+/g, ' ').trim();
    if (!titulo) return;
    const texto = bloco.text().replace(/\s+/g, ' ').trim();
    const data = parseDataBR(texto);
    if (!dentroDaJanela(data || new Date())) return;
    itens.push({
      id: 'noticia-' + urlItem,
      origem: 'Notícia institucional',
      data: data || new Date(),
      dataTexto: data ? formatarData(data) : '-',
      titulo,
      descricao: texto.slice(0, 500) || 'Notícia institucional da CMPA usada como fallback do Radar de Pautas.',
      proponente: 'CMPA',
      url: urlItem
    });
  });
  return itens.slice(0, 10);
}

async function buscarAudienciasPublicas() {
  const url = BASE + '/audiencias_publicas';
  const $ = cheerio.load(await get(url));
  const itens = [];
  const vistos = new Set();
  $('article.item, .ui.items .item, main a[href*="/audiencias_publicas"]').each(function () {
    const bloco = $(this);
    const a = bloco.is('a') ? bloco : bloco.find('a[href*="/audiencias_publicas"]').first();
    const href = a.attr('href');
    const urlItem = absoluto(href, BASE);
    if (!urlItem || urlItem === url || vistos.has(urlItem)) return;
    vistos.add(urlItem);
    const titulo = a.text().replace(/\s+/g, ' ').trim() || bloco.find('.header,h2,h3').first().text().replace(/\s+/g, ' ').trim();
    if (!titulo) return;
    const texto = bloco.text().replace(/\s+/g, ' ').trim();
    const data = parseDataBR(texto);
    if (!dentroDaJanela(data || new Date())) return;
    itens.push({
      id: 'audiencia-' + urlItem,
      origem: 'Audiência Pública',
      data: data || new Date(),
      dataTexto: data ? formatarData(data) : '-',
      titulo,
      descricao: texto.slice(0, 500) || 'Audiência pública da CMPA usada como camada de agenda do Radar de Pautas.',
      proponente: 'CMPA',
      url: urlItem
    });
  });
  return itens.slice(0, 10);
}

async function enviarEmail(novas) {
  if (DRY_RUN) {
    console.log('DRY_RUN ativo. Email nao sera enviado.');
    for (const p of novas) {
      console.log('- ' + p.dataTexto + ' | ' + p.origem + ' | ' + p.titulo + ' | ' + p.url);
    }
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA }
  });
  const rows = novas.map(function (p) {
    return '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">' + html(p.dataTexto) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">' + html(p.origem) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee">' + html(p.titulo) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee">' + html(p.descricao) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><a href="' + html(p.url) + '" style="color:#1a3a5c">Abrir</a></td>' +
      '</tr>';
  }).join('');
  const body = [
    '<div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto">',
    '<h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">Radar de Pautas CMPA — ' + novas.length + ' pauta(s) nova(s)</h2>',
    '<p style="color:#555">Fontes: sessões plenárias, Portal Transparência / pautas de reuniões de comissões, audiências públicas e notícias institucionais da CMPA.</p>',
    '<p style="color:#7a4a00;background:#fff7e6;border:1px solid #ffd58a;padding:10px;border-radius:4px">Comissões, audiências e notícias entram como Radar de agenda/pauta. Plenário será a próxima camada para Pauta Analisada/Mesa, porque o detalhe da sessão contém itens legislativos parseáveis.</p>',
    '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#1a3a5c;color:white">',
    '<th style="padding:10px;text-align:left">Data</th><th style="padding:10px;text-align:left">Origem</th><th style="padding:10px;text-align:left">Título</th><th style="padding:10px;text-align:left">Descrição</th><th style="padding:10px;text-align:left">Link</th>',
    '</tr></thead><tbody>' + rows + '</tbody></table></div>'
  ].join('');
  await transporter.sendMail({
    from: '"Monitor Porto Alegre" <' + EMAIL_REMETENTE + '>',
    to: EMAIL_DESTINO,
    subject: 'Radar de Pautas CMPA: ' + novas.length + ' pauta(s) nova(s) — ' + new Date().toLocaleDateString('pt-BR'),
    html: body
  });
  console.log('Email enviado com ' + novas.length + ' pauta(s) nova(s).');
}

(async function main() {
  console.log('Iniciando Radar de Pautas CMPA...');
  const estado = carregarEstado();
  const vistos = new Set(estado.pautas_vistas || []);
  const pautas = (await Promise.all([buscarPlenario(), buscarComissoes(), buscarAudienciasPublicas(), buscarNoticiasInstitucionais()]))
    .flat()
    .sort(function (a, b) { return a.data - b.data; });
  const novas = pautas.filter(function (p) { return !vistos.has(p.id); });
  console.log('Pautas futuras na janela: ' + pautas.length + '; novas: ' + novas.length);
  if (novas.length) {
    await enviarEmail(novas);
    if (!DRY_RUN) {
      for (const pauta of novas) vistos.add(pauta.id);
      estado.pautas_vistas = Array.from(vistos);
      estado.ultima_execucao = new Date().toISOString();
      salvarEstado(estado);
    }
  } else {
    console.log('Sem pautas novas na janela. Nada a enviar.');
  }
})();
