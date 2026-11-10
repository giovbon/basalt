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
mostra o mapa mental atualizado durante a edição. Para limitar a largura das
caixas dos nós, adicione manualmente ao frontmatter:

```yaml
markmap:
  maxWidth: 400
```

As cores do mapa acompanham o tema ativo, inclusive nos temas claros.

### Consultas no Markdown

Blocos `query` exibem resultados gerados a partir das notas do vault. `query` é
o identificador recomendado; `basalt-query` também é aceito como alias. O
conteúdo do bloco é YAML declarativo e nunca executa JavaScript:

````markdown
```query
type: table
from: Projetos
where:
  status: "em andamento"
sort: due
order: asc
columns: [file.name, status, due]
limit: 20
```
````

#### Opções

| Chave | Uso |
| --- | --- |
| `type` | Formato: `list`, `table` ou `task`. Obrigatório. |
| `from` | Pasta do vault; inclui a pasta e suas subpastas. Omitir pesquisa o vault todo. |
| `where` | Mapa de propriedades do frontmatter e/ou tags que a nota precisa corresponder. |
| `sort` | Campo pelo qual ordenar; padrão `file.path`. |
| `order` | `asc` ou `desc`; padrão `asc`. |
| `columns` | Campos mostrados por `table`; padrão `file.name, file.modified`. Em `list`, o padrão é `file.name`; em `task`, `task.text, file.name`. |
| `limit` | Número máximo de resultados; padrão 50, mínimo 1, máximo 100. |

#### Campos disponíveis

Campos de arquivo: `file.name`, `file.path`, `file.folder`, `file.modified`,
`file.size` e `file.tags`. Também é possível usar qualquer chave do frontmatter,
por exemplo `status`, `due` ou `project.owner`. Chaves são comparadas sem
diferenciar maiúsculas de minúsculas. Os valores podem ser texto, números,
booleanos ou listas desses valores.

Uma condição `where` exige igualdade. Texto é comparado sem diferenciar
maiúsculas de minúsculas; uma lista no frontmatter ou no filtro corresponde se
qualquer valor for igual. Várias chaves em `where` são combinadas com **E**.
Não há operadores de comparação (`>`, `<`), busca parcial, `OR`, agrupamento
ou agregações neste MVP.

#### Filtrar por tags

Use `tags` ou `file.tags` em `where`. Tanto uma tag como uma lista de tags no
filtro são aceitas; a lista significa “qualquer uma destas tags”:

````markdown
```query
type: list
where:
  tags: leitura
```
````

````markdown
```query
type: table
where:
  file.tags: [trabalho, urgente]
columns: [file.name, file.tags, status]
```
````

As tags vêm do `tags:` ou `tag:` no frontmatter e são normalizadas para
minúsculas. Uma lista `where` não exige que todas as tags estejam presentes.
Para exigir duas tags, escreva ambas como chaves:

```yaml
where:
  tags: trabalho
  status: ativo
```

#### Exemplos de tipos

Listar notas de uma pasta com status ativo:

````markdown
```query
type: list
from: Projetos
where:
  status: ativo
sort: due
```
````

Exibir tarefas abertas ou concluídas encontradas nas notas que atendem aos
filtros de frontmatter/tags:

````markdown
```query
type: task
from: Projetos
where:
  status: ativo
```
````

`task` identifica itens Markdown no formato `- [ ] tarefa`, `* [x] tarefa` ou
`+ [X] tarefa`. Seus campos de saída são `task.text` e `task.completed`.
Blocos de código e o frontmatter não são interpretados como tarefas.

Uma nota pode conter até cinco blocos de consulta; cada consulta aceita YAML
de até 8 KiB. Resultados são recalculados ao renderizar o preview. Erros de
sintaxe ou de execução são exibidos no lugar do resultado.

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

Os métodos de configuração do Alpine são compostos a partir de fatias focadas:
inicialização em `src/app/bootstrap.js`, preferências em
`src/app/local-settings.js`, temas em `src/app/theme-settings.js` e traduções e
notificações em `src/app/localization.js`.

Para medir listagem e busca em vaults de 100, 1.000 e 10.000 notas:

```bash
go test ./internal/vault -run '^$' -bench 'BenchmarkVault' -benchmem
```

Os benchmarks comparam snapshot quente, varredura do filesystem com índice
aquecido, índice frio e busca com cache de texto quente/frio. Use `-count=5`
para comparar mudanças e rode na mesma máquina e no mesmo filesystem; o
resultado varia conforme o disco e o hardware.

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
npm ci
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
| `NTFY_ENABLED` | `false` | Ativa o monitoramento de um tópico ntfy. |
| `NTFY_SERVER_URL` | `https://ntfy.sh` | URL base do servidor ntfy (pode ser self-hosted). |
| `NTFY_TOPIC` | *(vazio)* | Tópico a monitorar; obrigatório quando o recurso está ativo. |
| `NTFY_USERNAME` | *(vazio)* | Usuário da conta ntfy (para tópicos protegidos). |
| `NTFY_PASSWORD` | *(vazio)* | Senha da conta ntfy (para tópicos protegidos). |
| `NTFY_CAPTURE_DIR` | `Captura` | Pasta relativa a `NOTES_DIR` onde as capturas serão salvas. |
| `NTFY_TAGS` | `ntfy` | Tags separadas por vírgulas aplicadas a todas as notas capturadas. |

### Captura de mensagens do ntfy

O monitoramento é opcional e roda no servidor. Você pode configurá-lo no painel
lateral **Configurações > Captura via ntfy**; ao salvar, as alterações são
gravadas no `config.yaml` e aplicadas imediatamente. Também é possível configurar
diretamente no arquivo:

```yaml
ntfy:
  enabled: true
  server_url: "https://ntfy.sh"
  topic: "meu-topico"
  username: "" # opcional para tópicos protegidos
  password: "" # opcional para tópicos protegidos
  capture_dir: "Captura"
  tags: [ntfy, captura]
```

Para tópicos protegidos, preencha usuário e senha juntos. A senha é armazenada
no `config.yaml` com permissões restritas e nunca é devolvida pela API; deixe o
campo vazio no painel para manter a senha salva.

Cada nova mensagem vira uma nota Markdown com as tags configuradas na pasta de
captura dentro do vault; anexos são salvos ao lado e vinculados na nota. As tags
são definidas em **Configurações > Captura via ntfy**, separadas por vírgulas.
O padrão é `ntfy`. Ao iniciar pela primeira vez, o monitor ignora o histórico
anterior e salva o estado dos eventos processados em `.basalt-ntfy-state.json`
dentro de `NOTES_DIR`, evitando recriar notas apagadas
ao reiniciar ou reconectar. Anexos precisam estar hospedados no mesmo servidor
ntfy configurado e têm limite de 100 MB. Em Docker, a pasta e o estado ficam
persistentes no volume de `NOTES_DIR`.
Variáveis `NTFY_*` definidas no ambiente prevalecem sobre o arquivo na próxima
inicialização. `NTFY_TAGS` também aceita uma lista separada por vírgulas.

---

## Offline-First (PWA)

O Basalt funciona **offline** como um Progressive Web App (PWA): você abre o app, edita notas e as alterações são sincronizadas automaticamente quando a conexão volta.

### O que funciona offline

- ✅ Abrir e ler notas já visitadas (cache no navegador)
- ✅ Editar notas **existentes** (apenas texto Markdown)
- ✅ Salvamento automático (debounce) enquanto offline — as edições ficam na fila local
- ✅ Sincronização automática ao reconectar (compare-and-swap via hash de conteúdo)
- ✅ Detecção de conflito: se o servidor mudou a nota enquanto você editava offline, sua versão vira uma nota-irmã `arquivo.offline-conflict-<timestamp>.md` — nada é perdido
- ✅ Indicadores visuais: status offline, “salvando localmente”, “pendente de sincronizar”, “nota do cache”

### O que **não** funciona offline (limitações atuais)

- ❌ Criar, renomear ou excluir notas/pastas
- ❌ Upload de mídia (imagens, áudio, vídeo, PDFs)
- ❌ Cache de mídia anexada
- ❌ Logout não limpa o cache local (use modo privado/incógnito em computadores públicos)

### Tecnologias usadas

| Camada | Tecnologia | Papel |
|--------|------------|-------|
| Armazenamento local | **IndexedDB** (via [`idb`](https://www.npmjs.com/package/idb) 8.x) | 4 object stores: `notes` (sumários), `documents` (conteúdo completo + hash), `outbox` (operações em fila), `meta` (chave/valor) |
| Fila de sincronização | **Outbox FIFO** (auto-increment `seq`) | `queueSave()` coalesce edições da mesma nota (mantém primeiro `opId` e `baseHash`); replay single-flight |
| Sincronização | **Compare-and-swap** (hash SHA-256 do conteúdo) | Go: `SaveNoteIfHash`; frontend: `baseHash` no payload; 409 → conflito → cópia-irmã |
| Service Worker | **Workbox-style** (precache + runtime cache) | Precacha shell (`index.html`, `app.js`, vendor, temas, locales); navegação cai para `/index.html`; assets estáticos em runtime cache |
| PWA Manifest | `manifest.webmanifest` | Instalável, ícones, `display: standalone`, `scope: /` |
| Testes | Playwright (E2E serial), `fake-indexeddb` (unitários) | 20 testes E2E + 192 testes unitários |

### Arquitetura do offline (resumo)

1. **Startup** (`bootstrap.js`):
   - Abre IndexedDB (`_offlineReady()` com timeout 5 s)
   - `replaceSummaries()` espelha `/api/notes` (dropa notas deletadas no servidor)
   - Aguarda `_syncPendingSaves()` **antes** de abrir a nota da URL — assim edições enfileiradas chegam antes do load

2. **Cache de documento** (`notes.js`):
   - Ao abrir nota online: `putDocument({ path, content, hash, outline, frontmatter, backlinks, tags })`
   - Offline: `loadNote()` lê do `documents` store; indicador “cached” aparece no editor

3. **Salvamento offline** (`notes.js` → `_sendNoteSave`):
   - Se `syncingOfflineSaves` ou fetch falha (rede/5xx): `queueSave({ path, content, baseHash })` + atualiza `documents` com hash antigo
   - `baseHash` = versão do servidor onde a edição começou → CAS no replay
   - `ackOp(opId, {updatedAt})` recusa exclusão se houver edição mais nova coalescida

4. **Replay** (`outbox-sync.js`):
   - Single-flight, ordenado por `seq`
   - POST `/api/notes/{path}` com `base_hash`
   - 200/201 → `ackOp` + `rebasePath(path, newHash)` (evita falso 409 na próxima passada)
   - 409 → `onConflict` → cria cópia-irmã `*.offline-conflict-<stamp>.md` com `baseHash=""`
   - 4xx (exceto 409) → loga erro, continua; 5xx/transport → **para a passada**, agenda retry

5. **Retry automático**:
   - A cada 15 s (`OFFLINE_SYNC_RETRY_MS`) enquanto houver fila e estiver online
   - Notificação “X notas sincronizadas” ao drenar a fila

6. **Indicadores no editor** (`partials/main/editor.html`):
   - `offline.status` (amarelo) — sem conexão
   - `offline.syncing` — replay em andamento
   - `offline.pending` (contagem) — fila não vazia, aguardando retry
   - `offline.cached` — nota veio do IndexedDB

### Como testar manualmente

```bash
# 1. Suba o servidor
./run.sh

# 2. Abra http://localhost:8000, espere o SW registrar (console: "SW registered")
# 3. Abra uma nota → edite → feche aba
# 4. Desligue a rede (ou DevTools → Network → Offline)
# 5. Recarregue → a nota abre do cache (badge "cached")
# 6. Edite offline → indicador "salvo localmente" + contador "pendente"
# 7. Religue a rede → toast "X notas sincronizadas"
# 8. Se houver conflito no servidor → aparece `arquivo.offline-conflict-*.md` na sidebar
```

### Em computadores públicos

O cache fica no **navegador do dispositivo** (IndexedDB por origem). Em um PC público:
- Use **modo privado/incógnito** — o cache morre ao fechar a janela
- Ou limpe dados do site (`DevTools → Application → Storage → Clear site data`) antes de sair
- Não há sincronização automática entre dispositivos; para isso use o servidor (mesmo vault, mesmo `NOTES_DIR`) ou exporte/importe manualmente