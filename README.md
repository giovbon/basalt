# Basalt (Go) 🌋

Uma aplicação rápida, leve e autocontida para gerenciamento de notas em Markdown, suporte a tags, links bidirecionais (wikilinks), grafo visual, mídias (áudio, vídeo, PDFs, imagens) e busca instantânea de texto completo.

Esta versão possui o **backend totalmente reescrito em Go**, mantendo paridade com o frontend e oferecendo inicialização instantânea, baixo consumo de memória (~20MB) e distribuição em binário único sem dependências externas. Baseado em [notediscovery](https://github.com/gamosoft/NoteDiscovery).

## Como Rodar Localmente

### Pré-requisitos
- [Go](https://go.dev/) 1.27 ou superior instalado.
- [Node.js](https://nodejs.org/) 26 ou superior (necessário para build e testes do frontend).

### Executando com o script facilitador

Basta rodar na raiz do projeto:

```bash
./run.sh
```

O script:
1. Compila o binário automaticamente.
2. Libera a porta caso haja alguma instância anterior presa.
3. Cria a pasta `./data` para suas notas (se ainda não existir).
4. Inicia o servidor e disponibiliza o app em **http://localhost:8000**.

Para rodar em outra porta:
```bash
PORT=8080 ./run.sh
```

### Notas de mapa mental

Para renderizar uma nota como mapa mental no painel de visualização, defina
`note-type: markmap` no frontmatter YAML:

```markdown
---
note-type: markmap
---
# Projeto
## Planejamento
- Próxima etapa
```

O conteúdo continua editável como Markdown; no modo dividido, o painel ao lado
mostra o mapa mental atualizado durante a edição.

### Desenvolvimento: alterando a interface

O JavaScript é modular: as fontes ficam em `web/frontend/src/` (ES modules) e
são empacotadas em `web/frontend/app.js` pelo esbuild. O build também gera o
bundle local do Markmap, carregado somente por notas desse tipo. **Não edite
os arquivos gerados** — depois de instalar as dependências frontend e mexer em
`src/`:

```bash
(cd web/frontend && npm ci)
./build-js.sh        # requer Node.js 26+/npm; regenera os bundles frontend
(cd web/frontend && npm test)
```

O HTML também é modular: `web/frontend/index.html` é só o esqueleto da página
(`<!DOCTYPE>`, `<body>` e os `<!-- @include ... -->`). Os blocos ficam em
`web/frontend/partials/` (head/styles, sidebar com um arquivo por painel, main
com graph/homepage/editor/media, modais etc.). O servidor Go resolve os
includes uma única vez na inicialização (`internal/web/html_partials.go`), então
não há passo de build para o HTML: edite o partial e reinicie o servidor.

No navegador, o Alpine registra um componente por painel (`Alpine.data` em
`src/main.js`): o `<body>` usa `x-data="noteApp"` e cada partial de painel usa
`x-data="filesPanel"`, `x-data="editorPanel"` etc. O estado continua único
(`src/app/state.js` + slices); o componente de painel é um facade
(`src/app/panel-scope.js`) que delega leituras, escritas e métodos ao root, sem
duplicar estado. Para adicionar um painel, inclua o nome em `PANEL_COMPONENTS`
e o `x-data` correspondente no partial.

O CSS do Tailwind é pré-compilado em `web/frontend/tailwind.css` (substitui o
antigo Play CDN de 408 KB que compilava estilos em runtime no navegador). Se
você adicionar ou renomear classes Tailwind em `index.html`, `partials/` ou
`src/`, regenere o CSS e commite junto com a mudança:

```bash
./build-tailwind.sh   # requer Node.js 26+/npm
```

Os testes de fumaça de ponta a ponta sobem o binário Go contra um vault
temporário (Playwright + Chromium):

```bash
cd web/frontend
npm install
npx playwright install chromium   # uma vez
npm run test:e2e
```

## Como Rodar com Docker & Docker Compose

### Usando o `docker-compose.yml`

Para subir o Basalt com persistência das suas notas na pasta `./data`:

```bash
docker compose up -d
```

Acesse no navegador: **http://localhost:8000**

Para parar a aplicação:
```bash
docker compose down
```

### Exemplo de `docker-compose.yml`

```yaml
services:
  basalt:
    image: giovbon/basalt:latest
    # Ou para construir a partir do código fonte:
    # build: .
    container_name: basalt
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - NOTES_DIR=/app/data
      - APP_NAME=Basalt
      - DEFAULT_THEME=light
      # Autenticação (opcional):
      # - AUTHENTICATION_ENABLED=true
      # - AUTHENTICATION_PASSWORD=sua_senha_segura
      # - AUTHENTICATION_SECRET_KEY=sua_chave_secreta_longa
    volumes:
      - ./data:/app/data
```

### Rodando diretamente via `docker run`

```bash
docker run -d \
  --name basalt \
  -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -e APP_NAME="Basalt" \
  giovbon/basalt:latest
```

## Variáveis de Ambiente Suportadas

Todas as variáveis podem ser definidas no ambiente ou via `docker-compose.yml`:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `PORT` | `8000` | Porta HTTP em que o servidor escutará. |
| `NOTES_DIR` | `./data` | Diretório onde as notas e anexos são armazenados. |
| `INDEX_FILE` | `.basalt-index.gob` ao lado do `config.yaml` | Caminho do cache do índice (gob, descartável). Em Docker, aponte para um volume montado (ex.: `/app/data/.basalt-index.gob`) para manter o índice quente entre restarts. |
| `APP_NAME` | `Basalt` | Nome exibido na interface e no título da aba. |
| `DEFAULT_THEME` | `light` | Tema inicial (`light`, `dark`, `dracula`, `nord`, etc.). |
| `AUTOSAVE_DELAY_MS` | `1000` | Debounce de salvamento automático (250ms a 60000ms). |
| `AUTHENTICATION_ENABLED` | `false` | Ativa a tela de login para proteger o cofre. |
| `AUTHENTICATION_PASSWORD` | `admin` | Senha de login (hasheada com bcrypt na inicialização). |
| `AUTHENTICATION_SECRET_KEY` | *(default inseguro)* | Chave secreta para assinar cookies HMAC de sessão. |
| `AUTHENTICATION_API_KEY` | *(vazio)* | Token para integrações via `Authorization: Bearer` ou `X-API-Key`. |
| `UPLOAD_MAX_IMAGE_MB` | `10` | Tamanho máximo de imagem permitido em upload. |
| `UPLOAD_MAX_AUDIO_MB` | `50` | Tamanho máximo de áudio permitido em upload. |
| `UPLOAD_MAX_VIDEO_MB` | `100` | Tamanho máximo de vídeo permitido em upload. |
| `UPLOAD_MAX_PDF_MB` | `20` | Tamanho máximo de PDF permitido em upload. |