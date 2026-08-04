import fs from 'node:fs/promises';
import {
  blocksToMarkdown, createPage, findProperty, getAllBlocks, getPropertyValue,
  getTitle, makeProperty, markdownToBlocks, openAIJson, queryDataSource,
  requireEnv, retrieveDataSource, slugIsSafe,
} from './lib.mjs';

const meetingId = requireEnv('NOTION_MEETING_LOG_DATA_SOURCE_ID');
const judgmentId = requireEnv('NOTION_JUDGMENT_LIBRARY_DATA_SOURCE_ID');
const draftId = requireEnv('NOTION_ARTICLE_DRAFT_DATA_SOURCE_ID');
const configPath = process.env.SUBSIDY_SOURCE_CONFIG || 'config/subsidy-sources.json';
const targetSite = process.env.NOTION_TARGET_SITE || '補助金';
const reviewStatus = process.env.NOTION_REVIEW_STATUS || '要レビュー';
const subsidyTag = process.env.NOTION_SUBSIDY_TAG || '補助金';

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
    .trim();
}

async function pageSummary(page, maxChars) {
  const blocks = await getAllBlocks(page.id);
  return {
    id: page.id,
    title: getTitle(page),
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    content: blocksToMarkdown(blocks).slice(0, maxChars),
  };
}

async function fetchOfficialSource(source) {
  const response = await fetch(source.url, {
    headers: {
      'User-Agent': 'CIZA-Subsidy-Content-Generator/1.0 (+https://hojokin.ciza.co.jp)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
  const content = normalizeHtml(await response.text()).slice(0, 7000);
  if (content.length < 200) throw new Error(`${source.name}: fetched content is unexpectedly short`);
  return { id: source.id, name: source.name, url: source.url, scope: source.scope, content };
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

const [meetingSchema, draftSchema, configRaw] = await Promise.all([
  retrieveDataSource(meetingId),
  retrieveDataSource(draftId),
  fs.readFile(configPath, 'utf8'),
]);

const tagProperty = findProperty(meetingSchema, ['タグ', '分類', 'テーマ'], 'multi_select');
const meetingQuery = {
  page_size: 30,
  sorts: [{ timestamp: 'created_time', direction: 'descending' }],
};
if (tagProperty) meetingQuery.filter = { property: tagProperty, multi_select: { contains: subsidyTag } };

const [meetingResult, judgmentResult, existingDraftResult] = await Promise.all([
  queryDataSource(meetingId, meetingQuery),
  queryDataSource(judgmentId, { page_size: 30, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }),
  queryDataSource(draftId, {
    page_size: 100,
    filter: { property: 'サイト', select: { equals: targetSite } },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  }),
]);

if (!meetingResult.results?.length) throw new Error(`No meeting logs found for tag: ${subsidyTag}`);

const usedMaterialUrls = new Set((existingDraftResult.results || []).map((page) => getPropertyValue(page, '元素材URL')).filter(Boolean));
const candidateMeetingPages = meetingResult.results.filter((page) => !usedMaterialUrls.has(page.url)).slice(0, 8);
if (!candidateMeetingPages.length) {
  console.log(JSON.stringify({ created: false, reason: 'No unused subsidy meeting logs found' }));
  process.exit(0);
}

const [meetings, judgments] = await Promise.all([
  Promise.all(candidateMeetingPages.map((page) => pageSummary(page, 4500))),
  Promise.all((judgmentResult.results || []).slice(0, 12).map((page) => pageSummary(page, 1800))),
]);

const config = JSON.parse(configRaw);
const officialSources = [];
for (const source of (config.sources || []).filter((item) => item.enabled).sort((a, b) => (a.priority || 99) - (b.priority || 99))) {
  try {
    officialSources.push(await fetchOfficialSource(source));
  } catch (error) {
    console.warn(error.message);
  }
}
if (!officialSources.length) throw new Error('No official subsidy sources could be fetched');

const existingTitles = (existingDraftResult.results || []).map(getTitle).filter(Boolean);
const today = new Date().toISOString().slice(0, 10);

const instructions = `あなたは株式会社シザコンサルティングの編集者です。川原拓馬の実際の補助金相談・支援経験と、官公庁または補助金事務局の公式情報をもとに、実務解説記事を1本作成してください。

目的:
- 中小企業の経営者が、補助金を使う前に何を確認すべきか分かる
- 川原の現場経験と判断基準が伝わる
- 検索から無料Web診断につながる

必須ルール:
- 会議ログから記事価値の高い相談・事例を1つ選ぶ
- 判断ライブラリの考え方を1つ以上使う
- 公式情報源を1つ選び、制度上の事実はその内容だけを根拠にする
- 選択した公式情報源に書かれていない補助率、上限額、締切、対象条件を作らない
- 企業名、個人名、固有の日付、固有の金額などは匿名化・変更する
- 事実にない成果や発言を作らない
- 既存タイトルと同じ論点を避ける
- 1記事1論点。2000〜3000字程度
- AI的な抽象表現を避け、「確認する」「一緒に考える」「発注前に見る」など自然な日本語にする
- body_markdownはfrontmatterと出典欄を含めず、H1から始める
- 最後に匿名化注記と [30分無料Web診断](/consultation/) への案内を入れる
- slugは英小文字・数字・ハイフンのみ`;

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    target_program: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 8 },
    source_page_id: { type: 'string' },
    source_title: { type: 'string' },
    source_url: { type: 'string' },
    official_source_id: { type: 'string' },
    official_source_reason: { type: 'string' },
    judgment_titles: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
    body_markdown: { type: 'string' },
  },
  required: [
    'title', 'slug', 'target_program', 'keywords', 'source_page_id', 'source_title',
    'source_url', 'official_source_id', 'official_source_reason', 'judgment_titles', 'body_markdown',
  ],
};

const article = await openAIJson({
  instructions,
  input: JSON.stringify({
    meetings,
    judgments,
    official_sources: officialSources,
    existing_titles: existingTitles,
    information_checked_at: today,
  }, null, 2),
  schema,
  name: 'subsidy_practical_article_draft',
});

if (!meetings.some((meeting) => meeting.id === article.source_page_id)) throw new Error('Model selected an unknown meeting log');
if (!slugIsSafe(article.slug)) throw new Error(`Unsafe generated slug: ${article.slug}`);
const selectedOfficialSource = officialSources.find((source) => source.id === article.official_source_id);
if (!selectedOfficialSource) throw new Error(`Model selected an unknown official source: ${article.official_source_id}`);
if (!article.body_markdown.startsWith('# ')) throw new Error('Generated article body must start with H1');

const titleName = findProperty(draftSchema, ['タイトル', '記事タイトル', '名前', 'Name'], 'title');
if (!titleName) throw new Error('Shared article database has no title property');
const properties = { [titleName]: makeProperty('title', article.title) };

setPropertyIfPresent(properties, draftSchema, ['ステータス', 'Status'], ['status', 'select'], reviewStatus);
setPropertyIfPresent(properties, draftSchema, ['サイト', 'Site'], ['select'], targetSite);
setPropertyIfPresent(properties, draftSchema, ['記事種別'], ['select'], '実務解説');
setPropertyIfPresent(properties, draftSchema, ['生成日'], ['date'], today);
setPropertyIfPresent(properties, draftSchema, ['情報確認日'], ['date'], today);
setPropertyIfPresent(properties, draftSchema, ['元素材'], ['rich_text'], article.source_title);
setPropertyIfPresent(properties, draftSchema, ['元素材URL'], ['url'], article.source_url);
setPropertyIfPresent(properties, draftSchema, ['出典名'], ['rich_text'], selectedOfficialSource.name);
setPropertyIfPresent(properties, draftSchema, ['出典URL'], ['url'], selectedOfficialSource.url);
setPropertyIfPresent(properties, draftSchema, ['対象制度'], ['rich_text'], article.target_program);
setPropertyIfPresent(properties, draftSchema, ['変更内容'], ['rich_text'], `実務解説記事。公式情報を選んだ理由: ${article.official_source_reason}`);
setPropertyIfPresent(properties, draftSchema, ['狙うキーワード'], ['rich_text'], article.keywords.join('、'));
setPropertyIfPresent(properties, draftSchema, ['スラッグ', 'slug', 'Slug'], ['rich_text'], article.slug);

const page = await createPage(draftId, properties, markdownToBlocks(article.body_markdown));
console.log(JSON.stringify({
  created: true,
  site: targetSite,
  articleType: '実務解説',
  title: article.title,
  notionUrl: page.url,
  source: article.source_title,
  officialSource: selectedOfficialSource.name,
}, null, 2));
