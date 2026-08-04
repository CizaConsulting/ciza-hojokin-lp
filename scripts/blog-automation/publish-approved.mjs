import fs from 'node:fs/promises';
import path from 'node:path';
import {
  blocksToMarkdown, escapeYaml, findProperty, getAllBlocks, getPropertyValue,
  getTitle, makeProperty, queryDataSource, requireEnv, retrieveDataSource,
  slugIsSafe, splitKeywords,
} from './lib.mjs';

const draftId = requireEnv('NOTION_ARTICLE_DRAFT_DATA_SOURCE_ID');
const approvedStatus = process.env.NOTION_APPROVED_STATUS || '承認';
const publishedStatus = process.env.NOTION_PUBLISHED_STATUS || '公開済';
const targetSite = process.env.NOTION_TARGET_SITE || '補助金';
const siteUrl = (process.env.PUBLIC_SITE_URL || 'https://hojokin.ciza.co.jp').replace(/\/$/, '');
const expectedHost = process.env.EXPECTED_PUBLIC_HOST || 'hojokin.ciza.co.jp';
const blogDir = process.env.BLOG_CONTENT_DIR || 'src/content/blog';

const parsedSiteUrl = new URL(siteUrl);
if (parsedSiteUrl.hostname !== expectedHost) {
  throw new Error(`Unsafe publication host: ${parsedSiteUrl.hostname}; expected ${expectedHost}`);
}

const schema = await retrieveDataSource(draftId);
const statusName = findProperty(schema, ['ステータス', 'Status'], 'status')
  || findProperty(schema, ['ステータス', 'Status'], 'select');
const siteName = findProperty(schema, ['サイト', 'Site'], 'select');
if (!statusName || !siteName) throw new Error('Shared article database requires ステータス and サイト properties');

const statusType = schema.properties[statusName].type;
const filter = {
  and: [
    statusType === 'status'
      ? { property: statusName, status: { equals: approvedStatus } }
      : { property: statusName, select: { equals: approvedStatus } },
    { property: siteName, select: { equals: targetSite } },
  ],
};

const result = await queryDataSource(draftId, {
  page_size: 10,
  filter,
  sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
});

if (!result.results?.length) {
  console.log(JSON.stringify({ published: false, reason: `No approved article for site: ${targetSite}` }));
  process.exit(0);
}

const page = result.results[0];
if (getPropertyValue(page, siteName) !== targetSite) throw new Error('Publication target mismatch');

const articleType = getPropertyValue(page, '記事種別') || '実務解説';
const sourceName = getPropertyValue(page, '出典名');
const sourceUrl = getPropertyValue(page, '出典URL');
const checkedAt = getPropertyValue(page, '情報確認日');
const targetProgram = getPropertyValue(page, '対象制度');
const existingArticleUrl = getPropertyValue(page, '既存記事URL');
const title = getTitle(page);

if (!title) throw new Error('Approved article has no title');
if (!sourceName || !sourceUrl || !checkedAt) {
  throw new Error(`Subsidy article "${title}" requires 出典名, 出典URL and 情報確認日`);
}
const parsedSourceUrl = new URL(sourceUrl);
if (!['https:', 'http:'].includes(parsedSourceUrl.protocol)) throw new Error('Invalid source URL');

let slug = getPropertyValue(page, 'スラッグ');
if (!slug && existingArticleUrl) {
  slug = new URL(existingArticleUrl).pathname.split('/').filter(Boolean).at(-1) || '';
}
if (!slugIsSafe(slug)) throw new Error(`Missing or unsafe slug: ${slug}`);

let body = blocksToMarkdown(await getAllBlocks(page.id)).trim();
body = body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
body = body.replace(/\n## 出典・情報確認日[\s\S]*$/m, '').trim();
if (!body.startsWith('# ')) body = `# ${title}\n\n${body}`;

const paragraph = body
  .split(/\n\s*\n/)
  .map((part) => part.replace(/\s+/g, ' ').trim())
  .find((part) => part && !part.startsWith('#') && !part.startsWith('-') && !part.startsWith('>')) || title;
const directAnswer = paragraph.slice(0, 220);
const description = paragraph.slice(0, 155);

const keywords = splitKeywords(getPropertyValue(page, '狙うキーワード'));
if (targetProgram && !keywords.includes(targetProgram)) keywords.unshift(targetProgram);
const tags = [...new Set(keywords)].slice(0, 8);
const contentType = articleType === '実務解説' ? '実務ガイド' : '補助金ニュース';
const category = articleType === '実務解説' ? '申請実務' : '制度情報';
const today = new Date().toISOString().slice(0, 10);

await fs.mkdir(blogDir, { recursive: true });
const filePath = path.join(blogDir, `${slug}.md`);
let publishedAt = today;
let updatedAtLine = '';

if (articleType === '既存記事更新') {
  let existing;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Existing article not found for update: ${filePath}`);
    throw error;
  }
  const existingPublishedAt = existing.match(/^publishedAt:\s*["']?([^\n"']+)/m)?.[1]?.trim();
  if (existingPublishedAt) publishedAt = existingPublishedAt;
  updatedAtLine = `updatedAt: ${today}\n`;
} else {
  try {
    await fs.access(filePath);
    throw new Error(`Article file already exists: ${filePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const sourceSection = `## 出典・情報確認日\n\n- 出典： [${sourceName}](${sourceUrl})\n- 情報確認日：${checkedAt}\n\n補助金や支援制度は、公募回や時期によって内容が変わります。申請時には必ず最新の公式資料をご確認ください。`;

const frontmatter = `---\ntitle: ${escapeYaml(title)}\ndescription: ${escapeYaml(description)}\npublishedAt: ${publishedAt}\n${updatedAtLine}officialCheckedAt: ${checkedAt}\ncontentType: ${escapeYaml(contentType)}\ncategory: ${escapeYaml(category)}\ntags: ${JSON.stringify(tags)}\nauthor: ${escapeYaml('川原 拓馬')}\nreviewer: ${escapeYaml('株式会社シザコンサルティング')}\nofficialSources:\n  - title: ${escapeYaml(sourceName)}\n    url: ${escapeYaml(sourceUrl)}\ndraft: false\ndirectAnswer: ${escapeYaml(directAnswer)}\n---`;

await fs.writeFile(filePath, `${frontmatter}\n\n${body}\n\n${sourceSection}\n`, 'utf8');

const publishedUrl = `${siteUrl}/blog/${slug}`;
if (new URL(publishedUrl).hostname !== expectedHost) throw new Error('Generated publication URL has wrong host');

const updates = { [statusName]: makeProperty(statusType, publishedStatus) };
const publishedDateName = findProperty(schema, ['公開日', 'Published date'], 'date');
const publishedUrlName = findProperty(schema, ['公開URL', 'Published URL'], 'url');
if (publishedDateName) updates[publishedDateName] = makeProperty('date', today);
if (publishedUrlName) updates[publishedUrlName] = makeProperty('url', publishedUrl);

await fs.writeFile('.blog-publish-result.json', JSON.stringify({
  page_id: page.id,
  title,
  slug,
  article_type: articleType,
  content_type: contentType,
  file_path: filePath,
  published_url: publishedUrl,
  notion_updates: updates,
}, null, 2));

console.log(JSON.stringify({ prepared: true, title, slug, article_type: articleType, content_type: contentType, file_path: filePath }, null, 2));
