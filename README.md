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
| `NTFY_ENABLED` | `false` | Ativa o monitoramento de um tópico ntfy. |
| `NTFY_SERVER_URL` | `https://ntfy.sh` | URL base do servidor ntfy (pode ser self-hosted). |
| `NTFY_TOPIC` | *(vazio)* | Tópico a monitorar; obrigatório quando o recurso está ativo. |
| `NTFY_USERNAME` | *(vazio)* | Usuário da conta ntfy (para tópicos protegidos). |
| `NTFY_PASSWORD` | *(vazio)* | Senha da conta ntfy (para tópicos protegidos). |
| `NTFY_CAPTURE_DIR` | `Captura` | Pasta relativa a `NOTES_DIR` onde as capturas serão salvas. |

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
```

Para tópicos protegidos, preencha usuário e senha juntos. A senha é armazenada
no `config.yaml` com permissões restritas e nunca é devolvida pela API; deixe o
campo vazio no painel para manter a senha salva.

Cada nova mensagem vira uma nota Markdown na pasta `Captura` dentro do vault;
anexos são salvos ao lado e vinculados na nota. Ao iniciar pela primeira vez, o
monitor ignora o histórico anterior e salva o estado dos eventos processados em
`.basalt-ntfy-state.json` dentro de `NOTES_DIR`, evitando recriar notas apagadas
ao reiniciar ou reconectar. Anexos precisam estar hospedados no mesmo servidor
ntfy configurado e têm limite de 100 MB. Em Docker, a pasta e o estado ficam
persistentes no volume de `NOTES_DIR`.
Variáveis `NTFY_*` definidas no ambiente prevalecem sobre o arquivo na próxima
inicialização.