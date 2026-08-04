import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPage, findProperty, getPropertyValue, getTitle, makeProperty,
  markdownToBlocks, openAIJson, queryDataSource, requireEnv, retrieveDataSource,
  slugIsSafe,
} from './lib.mjs';

const configPath = process.env.SUBSIDY_SOURCE_CONFIG || 'config/subsidy-sources.json';
const statePath = process.env.SUBSIDY_SOURCE_STATE || 'data/subsidy-source-state.json';
const blogDir = process.env.BLOG_CONTENT_DIR || 'src/content/blog';
const draftId = requireEnv('NOTION_ARTICLE_DRAFT_DATA_SOURCE_ID');
const targetSite = process.env.NOTION_TARGET_SITE || '補助金';
const reviewStatus = process.env.NOTION_REVIEW_STATUS || '要レビュー';
const maxStoredChars = 30000;

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function normalizeHtml(html) {
  return decodeEntities(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|section|article|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, maxStoredChars);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      'User-Agent': 'CIZA-Subsidy-Update-Monitor/1.0 (+https://hojokin.ciza.co.jp)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error(`${source.name}: unsupported content type ${contentType}`);
  }
  const html = await response.text();
  const content = normalizeHtml(html);
  if (content.length < 200) throw new Error(`${source.name}: fetched content is unexpectedly short`);
  return { content, hash: sha256(content), finalUrl: response.url };
}

function parseFrontmatterValue(markdown, key) {
  return markdown.match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)`, 'm'))?.[1]?.trim() || '';
}

function articleBody(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/\n## 出典・情報確認日[\s\S]*$/m, '')
    .trim()
    .slice(0, 7000);
}

async function listExistingArticles() {
  try {
    const files = (await fs.readdir(blogDir)).filter((name) => /\.mdx?$/.test(name)).slice(0, 10);
    const articles = [];
    for (const file of files) {
      const markdown = await fs.readFile(path.join(blogDir, file), 'utf8');
      articles.push({
        slug: file.replace(/\.mdx?$/, ''),
        title: parseFrontmatterValue(markdown, 'title'),
        description: parseFrontmatterValue(markdown, 'description'),
        current_body_markdown: articleBody(markdown),
      });
    }
    return articles;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function setPropertyIfPresent(properties, schema, names, types, value) {
  for (const type of types) {
    const name = findProperty(schema, names, type);
    if (name) {
      properties[name] = makeProperty(type, value);
      return;
    }
  }
}

const [configRaw, stateRaw, draftSchema, existingArticles, existingDraftResult] = await Promise.all([
  fs.readFile(configPath, 'utf8'),
  fs.readFile(statePath, 'utf8').catch((error) => error.code === 'ENOENT' ? '{"version":1,"sources":{}}' : Promise.reject(error)),
  retrieveDataSource(draftId),
  listExistingArticles(),
  queryDataSource(draftId, { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
]);

const config = JSON.parse(configRaw);
const state = JSON.parse(stateRaw);
state.version ||= 1;
state.sources ||= {};

const existingDrafts = (existingDraftResult.results || [])
  .filter((page) => getPropertyValue(page, 'サイト') === targetSite)
  .map((page) => ({
    title: getTitle(page),
    status: getPropertyValue(page, 'ステータス'),
    materialUrl: getPropertyValue(page, '元素材URL'),
    sourceUrl: getPropertyValue(page, '出典URL'),
  }));

let createdDraft = null;
let initialized = 0;
let unchanged = 0;
let minorChanges = 0;
let deferred = 0;
const errors = [];
const now = new Date();
const today = now.toISOString().slice(0, 10);

const sources = (config.sources || [])
  .filter((source) => source.enabled)
  .sort((a, b) => (a.priority || 99) - (b.priority || 99));

for (const source of sources) {
  let fetched;
  try {
    fetched = await fetchSource(source);
  } catch (error) {
    errors.push(error.message);
    continue;
  }

  const previous = state.sources[source.id];
  if (!previous) {
    state.sources[source.id] = {
      name: source.name,
      url: source.url,
      finalUrl: fetched.finalUrl,
      hash: fetched.hash,
      content: fetched.content,
      checkedAt: now.toISOString(),
    };
    initialized += 1;
    continue;
  }

  if (previous.hash === fetched.hash) {
    previous.checkedAt = now.toISOString();
    previous.finalUrl = fetched.finalUrl;
    unchanged += 1;
    continue;
  }

  if (createdDraft) {
    deferred += 1;
    continue;
  }

  const materialUrl = `${source.url}#sha256=${fetched.hash}`;
  if (existingDrafts.some((draft) => draft.materialUrl === materialUrl)) {
    state.sources[source.id] = {
      ...previous,
      finalUrl: fetched.finalUrl,
      hash: fetched.hash,
      content: fetched.content,
      checkedAt: now.toISOString(),
    };
    unchanged += 1;
    continue;
  }

  const instructions = `あなたは株式会社シザコンサルティングの補助金情報編集者です。官公庁または補助金事務局の公式ページの変更を確認し、中小企業の経営者に知らせる価値がある変更だけを記事案にしてください。

絶対ルール:
- 入力された公式ページの旧内容と新内容だけを根拠にする
- 日付、締切、補助率、上限額、対象者、対象経費を推測しない
- 公式ページで確認できない説明を書かない
- レイアウト変更、表記修正、更新日時だけの変化では記事を作らない
- 公募開始、締切変更、公募要領・FAQの重要変更、対象条件の変更、採択発表など、企業の行動に影響する変更を優先する
- 既存記事に追記すべき内容なら article_type を「既存記事更新」にし、existing_slug に既存記事一覧のslugを正確に入れる
- 既存記事更新の場合、body_markdownは既存記事の本文を土台に、変更部分を反映した完全な改訂後本文にする。変更と無関係な説明を削除しない
- 既存記事更新の場合はslugにもexisting_slugと同じ値を入れる
- 対応する既存記事がない場合は article_type を「制度更新」、existing_slug は空文字にする
- body_markdownにはfrontmatterと出典欄を入れない。H1から始める
- 「何が変わったか」「どの企業に関係するか」「申請を考えている企業が今すること」「注意点」を具体的に書く
- 誇張せず、1200〜2200字程度の日本語で書く
- should_create_draftがfalseの場合も、article_typeはどちらかを選び、他の文字列は空文字、keywordsは空配列で返す`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      should_create_draft: { type: 'boolean' },
      reason: { type: 'string' },
      article_type: { type: 'string', enum: ['制度更新', '既存記事更新'] },
      existing_slug: { type: 'string' },
      title: { type: 'string' },
      slug: { type: 'string' },
      target_program: { type: 'string' },
      change_summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      body_markdown: { type: 'string' },
    },
    required: [
      'should_create_draft', 'reason', 'article_type', 'existing_slug', 'title', 'slug',
      'target_program', 'change_summary', 'keywords', 'body_markdown',
    ],
  };

  const decision = await openAIJson({
    instructions,
    input: JSON.stringify({
      source: { name: source.name, url: source.url, scope: source.scope },
      previous_content: previous.content,
      current_content: fetched.content,
      existing_articles: existingArticles,
      existing_drafts: existingDrafts,
      information_checked_at: today,
    }, null, 2),
    schema,
    name: 'subsidy_update_article_decision',
  });

  if (!decision.should_create_draft) {
    state.sources[source.id] = {
      ...previous,
      finalUrl: fetched.finalUrl,
      hash: fetched.hash,
      content: fetched.content,
      checkedAt: now.toISOString(),
      lastDecision: decision.reason,
    };
    minorChanges += 1;
    continue;
  }

  let targetSlug;
  if (decision.article_type === '既存記事更新') {
    if (!decision.existing_slug || !existingArticles.some((article) => article.slug === decision.existing_slug)) {
      throw new Error(`Model selected an unknown existing article: ${decision.existing_slug}`);
    }
    targetSlug = decision.existing_slug;
  } else {
    if (!slugIsSafe(decision.slug)) throw new Error(`Unsafe generated slug: ${decision.slug}`);
    targetSlug = decision.slug;
  }
  if (!slugIsSafe(targetSlug)) throw new Error(`Unsafe target slug: ${targetSlug}`);
  if (!decision.body_markdown.startsWith('# ')) throw new Error('Generated article body must start with H1');

  const titleName = findProperty(draftSchema, ['タイトル', '記事タイトル', '名前', 'Name'], 'title');
  if (!titleName) throw new Error('Shared article database has no title property');
  const properties = { [titleName]: makeProperty('title', decision.title) };

  setPropertyIfPresent(properties, draftSchema, ['ステータス', 'Status'], ['status', 'select'], reviewStatus);
  setPropertyIfPresent(properties, draftSchema, ['サイト', 'Site'], ['select'], targetSite);
  setPropertyIfPresent(properties, draftSchema, ['記事種別'], ['select'], decision.article_type);
  setPropertyIfPresent(properties, draftSchema, ['生成日'], ['date'], today);
  setPropertyIfPresent(properties, draftSchema, ['情報確認日'], ['date'], today);
  setPropertyIfPresent(properties, draftSchema, ['元素材'], ['rich_text'], source.name);
  setPropertyIfPresent(properties, draftSchema, ['元素材URL'], ['url'], materialUrl);
  setPropertyIfPresent(properties, draftSchema, ['出典名'], ['rich_text'], source.name);
  setPropertyIfPresent(properties, draftSchema, ['出典URL'], ['url'], source.url);
  setPropertyIfPresent(properties, draftSchema, ['対象制度'], ['rich_text'], decision.target_program);
  setPropertyIfPresent(properties, draftSchema, ['変更内容'], ['rich_text'], decision.change_summary);
  setPropertyIfPresent(properties, draftSchema, ['狙うキーワード'], ['rich_text'], decision.keywords.join('、'));
  setPropertyIfPresent(properties, draftSchema, ['スラッグ', 'slug', 'Slug'], ['rich_text'], targetSlug);
  if (decision.article_type === '既存記事更新') {
    setPropertyIfPresent(properties, draftSchema, ['既存記事URL'], ['url'], `https://hojokin.ciza.co.jp/blog/${targetSlug}`);
  }

  const page = await createPage(draftId, properties, markdownToBlocks(decision.body_markdown));
  createdDraft = {
    title: decision.title,
    notionUrl: page.url,
    source: source.name,
    articleType: decision.article_type,
  };

  state.sources[source.id] = {
    ...previous,
    finalUrl: fetched.finalUrl,
    hash: fetched.hash,
    content: fetched.content,
    checkedAt: now.toISOString(),
    lastDraftTitle: decision.title,
    lastMaterialUrl: materialUrl,
  };
}

state.updatedAt = now.toISOString();
await fs.mkdir(path.dirname(statePath), { recursive: true });
await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  completed: true,
  initialized,
  unchanged,
  minorChanges,
  deferred,
  createdDraft,
  errors,
}, null, 2));
