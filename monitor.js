const fs = require('fs');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const BASE_URL = 'https://www.camarapoa.rs.gov.br';

// Tipos monitorados (todos os tipos legislativos relevantes da CMPA)
// Excluídos intencionalmente: EXEC (propostas do Executivo têm fluxo próprio), PA (processo administrativo)
const TIPOS_MONITORADOS = ['IND', 'PDL', 'PELO', 'PI', 'PLCE', 'PLCL', 'PLE', 'PLL', 'PP', 'PR', 'REQ', 'VC'];

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

// Extrai o HTML real do wrapper JS do Turbolinks/Rails
function extrairHtml(jsBody) {
  // O servidor retorna: (function() { $('.view').replaceWith('...HTML...'); ... }).call(this);
  // Precisamos extrair o HTML dentro do replaceWith
  const match = jsBody.match(/replaceWith\('([\s\S]+?)'\);\s*\n/);
  if (match) {
    // Desfaz os escapes que o Rails faz no HTML embutido em JS
    return match[1]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  // Fallback: talvez seja HTML puro (requisição direta sem JS)
  return jsBody;
}

async function buscarPagina(tipo, pagina) {
  const ano = new Date().getFullYear();
  const url = `${BASE_URL}/processos?utf8=%E2%9C%93&tipo=${tipo}&andamento=todos&ultima_tramitacao=${ano}&page=${pagina}`;

  console.log(`  🔗 GET ${url}`);

  const response = await fetch(url, {
    headers: {
      'Accept': 'text/javascript, application/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE_URL}/projetos`,
      'User-Agent': 'Mozilla/5.0 (compatible; monitor-cmpa/1.0)',
    }
  });

  if (!response.ok) {
    console.error(`  ❌ HTTP ${response.status} para tipo=${tipo} página=${pagina}`);
    return null;
  }

  const texto = await response.text();
  return extrairHtml(texto);
}

function parsearProposicoes(html, tipo) {
  const $ = cheerio.load(html);
  const proposicoes = [];

  $('article.item').each((_, el) => {
    const $el = $(el);

    // Título: "PROC. 00243/26 - PLL 147/26"
    const tituloEl = $el.find('h2.header a');
    const tituloTexto = tituloEl.text().trim();
    const href = tituloEl.attr('href') || '';

    // Extrai número do processo (ID único e estável)
    // href é /processos/142247 → ID = 142247
    const idMatch = href.match(/\/processos\/(\d+)/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) return;

    // Extrai tipo e número legislativo do título
    // "PROC. 00243/26 - PLL 147/26" → tipo=PLL, numero=147, ano=26
    const legislativoMatch = tituloTexto.match(/[-–]\s*([A-Z]+)\s+(\d+)\/(\d+)\s*$/);
    const tipoLeg = legislativoMatch ? legislativoMatch[1] : tipo;
    const numeroLeg = legislativoMatch ? legislativoMatch[2] : '-';
    const anoLeg = legislativoMatch ? `20${legislativoMatch[3]}` : String(new Date().getFullYear());

    // Número do processo: "PROC. 00243/26"
    const procMatch = tituloTexto.match(/PROC\.\s*([\d]+\/\d+)/i);
    const numProc = procMatch ? procMatch[1] : '-';

    // Ementa
    const ementa = $el.find('.description p').text().trim();

    // Autor e Situação (ficam em .meta > .list > .item)
    let autor = '-';
    let situacao = '-';
    $el.find('.meta .ui.horizontal.relaxed.list .item').each((_, span) => {
      const $span = $(span);
      const header = $span.find('.header').text().trim();
      const valor = $span.clone().children('.header').remove().end().text().trim();
      if (header === 'Autor') autor = valor;
      if (header === 'Situação') situacao = valor;
    });

    // Data da última tramitação
    const dataEl = $el.find('time');
    const dataRaw = dataEl.attr('title') || dataEl.text().trim();
    // "02/04/2026 13:33" → "02/04/2026"
    const data = dataRaw.split(' ')[0] || '-';

    // Setor da tramitação
    const setor = $el.find('.ui.small.horizontal.left.pointing.label').text().trim();

    proposicoes.push({
      id,
      tipo: tipoLeg,
      numero: numeroLeg,
      ano: anoLeg,
      numProc,
      autor,
      situacao,
      data,
      setor,
      ementa: ementa.substring(0, 250),
      url: `${BASE_URL}/processos/${id}`,
    });
  });

  return proposicoes;
}

function contarTotal(html) {
  const $ = cheerio.load(html);
  const statusTexto = $('#status-pagina').text();
  // "Exibindo registros 1 - 20 de 10724 no total"
  const match = statusTexto.match(/de\s+([\d.]+)\s+no total/);
  return match ? parseInt(match[1].replace(/\./g, '')) : 0;
}

async function buscarTipo(tipo) {
  console.log(`📂 Buscando tipo: ${tipo}`);
  const proposicoes = [];

  const html1 = await buscarPagina(tipo, 1);
  if (!html1) return [];

  const total = contarTotal(html1);
  const itensPorPagina = 20;
  const totalPaginas = Math.ceil(total / itensPorPagina);

  console.log(`  📊 ${total} proposições, ${totalPaginas} página(s)`);

  const lote1 = parsearProposicoes(html1, tipo);
  proposicoes.push(...lote1);

  // Limita a 5 páginas (100 proposições) por tipo por execução
  // para não sobrecarregar o servidor e manter execução rápida
  const paginasRestantes = Math.min(totalPaginas, 5);
  for (let p = 2; p <= paginasRestantes; p++) {
    await new Promise(r => setTimeout(r, 800)); // respeita o servidor
    const html = await buscarPagina(tipo, p);
    if (!html) break;
    const lote = parsearProposicoes(html, tipo);
    proposicoes.push(...lote);
  }

  console.log(`  ✅ ${proposicoes.length} proposições extraídas para ${tipo}`);
  return proposicoes;
}

async function buscarTodasProposicoes() {
  const todas = [];
  for (const tipo of TIPOS_MONITORADOS) {
    const lote = await buscarTipo(tipo);
    todas.push(...lote);
    await new Promise(r => setTimeout(r, 500));
  }
  return todas;
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo
  const porTipo = {};
  novas.forEach(p => {
    const t = p.tipo || 'OUTROS';
    if (!porTipo[t]) porTipo[t] = [];
    porTipo[t].push(p);
  });

  const avisoVolume = novas.length > 50
    ? `<div style="background:#fff3cd;border:1px solid #ffc107;padding:10px;margin-bottom:16px;border-radius:4px;font-size:13px">
        ⚠️ Volume alto: ${novas.length} novas proposições. Apenas as primeiras 100 por tipo são monitoradas por execução.
       </div>`
    : '';

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr>
      <td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">
        ${tipo} — ${porTipo[tipo].length} proposição(ões)
      </td>
    </tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px;white-space:nowrap">
          <a href="${p.url}" style="color:#1a3a5c;text-decoration:none" target="_blank">
            ${p.tipo} ${p.numero}/${p.ano}
          </a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#666;white-space:nowrap">PROC. ${p.numProc}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ CMPA — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;font-size:13px">
        Monitoramento automático — ${new Date().toLocaleString('pt-BR')}
      </p>
      ${avisoVolume}
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Proposição</th>
            <th style="padding:10px;text-align:left">Processo</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Últ. Tram.</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Portal: <a href="https://www.camarapoa.rs.gov.br/projetos">camarapoa.rs.gov.br/projetos</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMPA" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMPA: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

(async () => {
  console.log('🚀 Iniciando monitor CMPA (Câmara Municipal de Porto Alegre)...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  const todas = await buscarTodasProposicoes();

  if (todas.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada. Verifique se o site está acessível.');
    process.exit(0);
  }

  console.log(`\n📊 Total coletado: ${todas.length} proposições`);

  const novas = todas.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    // Ordena por tipo alfabético, depois número decrescente dentro do tipo
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });

    await enviarEmail(novas);

    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
