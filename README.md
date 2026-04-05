# 🏛️ Monitor Proposições — Câmara Municipal de Porto Alegre (CMPA)

Monitora automaticamente as proposições legislativas da Câmara Municipal de Porto Alegre e envia email quando há proposições novas com tramitação no ano corrente. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script faz GET no portal `camarapoa.rs.gov.br/processos` filtrando por tipo e ano de tramitação
3. Faz parse do HTML retornado (sistema Rails/Turbolinks, sem API JSON pública)
4. Compara as proposições encontradas com as já registradas no `estado.json`
5. Se há proposições novas → envia email organizado por tipo
6. Salva o estado atualizado no repositório

---

## Sistema utilizado

**Sistema próprio da CMPA** (Rails + Turbolinks, não é SAPL).

```
URL base:    https://www.camarapoa.rs.gov.br
Endpoint:    GET /processos?utf8=✓&tipo={TIPO}&andamento=todos&ultima_tramitacao={ANO}&page={N}
Resposta:    text/javascript com HTML injetado via replaceWith()
Auth:        Nenhuma
reCAPTCHA:   Não
```

---

## Tipos monitorados

| Sigla | Descrição |
|-------|-----------|
| IND   | Indicação |
| PDL   | Projeto de Decreto Legislativo |
| PELO  | Projeto de Emenda à Lei Orgânica |
| PI    | Projeto de Iniciativa Popular |
| PLCE  | Projeto de Lei Complementar do Executivo |
| PLCL  | Projeto de Lei Complementar Legislativo |
| PLE   | Projeto de Lei do Executivo |
| PLL   | Projeto de Lei Legislativo |
| PP    | Projeto de Resolução/Plenário |
| PR    | Projeto de Resolução |
| REQ   | Requerimento |
| VC    | Voto de Congratulações |

Tipos **não monitorados**: EXEC (propostas do Executivo com fluxo próprio), PA (processo administrativo interno).

---

## Estrutura do repositório

```
monitor-proposicoes-cmpa/
├── monitor.js                  # Script principal
├── package.json                # Dependências (nodemailer + cheerio)
├── estado.json                 # Estado salvo automaticamente
├── README.md                   # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml         # Workflow do GitHub Actions
```

---

## Setup — Passo a Passo

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Busque por **"Senhas de app"** e clique.

**1.4** Digite o nome `monitor-cmpa` e clique em **Criar**.

**1.5** Copie a senha de **16 letras** — ela só aparece uma vez.

> Se já tem App Password de outro monitor, pode reutilizar.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **+ → New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-cmpa`
- **Visibility:** Private

**2.3** Clique em **Create repository**

---

### PARTE 3 — Fazer upload dos arquivos

**3.1** Clique em **"uploading an existing file"**

**3.2** Faça upload de:
```
monitor.js
package.json
README.md
```
Clique em **Commit changes**.

**3.3** Clique em **Add file → Create new file**, digite:
```
.github/workflows/monitor.yml
```
Cole o conteúdo do `monitor.yml`. Clique em **Commit changes**.

---

### PARTE 4 — Configurar os Secrets

**4.1** No repositório: **Settings → Secrets and variables → Actions**

**4.2** Clique em **New repository secret** e crie os 3 secrets:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | a senha de 16 letras do App Password (sem espaços) |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

### PARTE 5 — Testar

**5.1** Vá em **Actions → Monitor Proposições CMPA → Run workflow → Run workflow**

**5.2** Aguarde ~2-3 minutos (o script consulta 12 tipos, ~1 página cada).

**5.3** Verde = funcionou. O **primeiro run** envia um email com todas as proposições do ano atual e salva o estado. A partir do segundo run, só envia se houver proposições novas.

---

## Email recebido

```
🏛️ CMPA — 8 nova(s) proposição(ões)

IND — 2 proposição(ões)
  IND 45/2026 | PROC. 00240/26 | JOAO SILVA | 02/04/2026 | Solicita...
  ...

PLL — 5 proposição(ões)
  PLL 147/2026 | PROC. 00243/26 | CLAUDIA ARAUJO | 02/04/2026 | Institui...
  ...
```

Cada linha tem link direto para o processo no portal da CMPA.

---

## Horários de execução

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00 | `0 11 * * *` |
| 12:00 | `0 15 * * *` |
| 17:00 | `0 20 * * *` |
| 21:00 | `0 0 * * *`  |

---

## Resetar o estado

Para forçar o reenvio de todas as proposições (útil para testar):

1. No repositório, clique em `estado.json` → lápis
2. Substitua o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode o workflow manualmente

---

## Problemas comuns

**Script retorna 0 proposições**
→ O portal pode estar fora do ar. Tente acessar `camarapoa.rs.gov.br/projetos` no navegador.

**Não aparece "Senhas de app" no Google**
→ Ative a verificação em duas etapas primeiro.

**Erro de autenticação no email**
→ Verifique se o secret `EMAIL_SENHA` tem exatamente 16 caracteres sem espaços.
