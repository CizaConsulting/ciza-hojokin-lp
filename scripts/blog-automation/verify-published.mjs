// 本番公開後の自動確認を行う。
//
// Claude Code のクラウドルーティンは egress プロキシにより自社ドメインへ到達できないため、
// HTTP による本番確認だけをこのスクリプトへ切り出し、GitHub Actions 上で実行する。
// 結果は data/publish-verification.json に保存し、ルーティンはそれを読んで Notion を同期する。
//
// 使い方:
//   node scripts/blog-automation/verify-published.mjs [slug ...]
// slug を省略した場合、直近のコミットで追加・変更された記事ファイルから自動判定する。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const siteBaseUrl = (process.env.SITE_BASE_URL || 'https://hojokin.ciza.co.jp').replace(/\/$/, '');
const blogDir = process.env.BLOG_CONTENT_DIR || 'src/content/blog';
const blogPathPrefix = process.env.BLOG_PATH_PREFIX || '/blog';
const outputPath = process.env.PUBLISH_VERIFICATION_OUTPUT || 'data/publish-verification.json';
// Vercel のデプロイ完了を待つ。反映前に判定して誤って失敗にしないため。
const maxWaitMs = Number(process.env.VERIFY_MAX_WAIT_MS || 10 * 60 * 1000);
const pollIntervalMs = Number(process.env.VERIFY_POLL_INTERVAL_MS || 20000);
const requestTimeoutMs = 30000;

function slugsFromLastCommit() {
  let output;
  try {
    output = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD', '--', blogDir], {
      encoding: 'utf8',
    });
  } catch (error) {
    // 浅いクローンなど HEAD~1 が存在しない場合。slug を明示指定して実行すること。
    console.error(`直前のコミットとの差分を取得できませんでした: ${error.message}`);
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md') || line.endsWith('.mdx'))
    .map((line) => line.split('/').pop().replace(/\.mdx?$/, ''));
}

async function get(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CIZA-Publish-Verifier/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await response.text();
    return { status: response.status, body, finalUrl: response.url };
  } catch (error) {
    return { status: 0, body: '', finalUrl: url, error: error.message };
  }
}

async function waitForArticle(url) {
  const deadline = Date.now() + maxWaitMs;
  let last = await get(url);
  while (last.status !== 200 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    last = await get(url);
  }
  return last;
}

const slugs = process.argv.slice(2).filter(Boolean);
const targets = slugs.length > 0 ? slugs : slugsFromLastCommit();

if (targets.length === 0) {
  console.log('検証対象の記事がありません。');
  process.exit(0);
}

// まず全記事のデプロイ完了を待ってから補助リソースを取得する。
// 先に sitemap や blogIndex を取得すると、デプロイ前の古い内容でチェックしてしまう。
const articleData = [];
for (const slug of targets) {
  const articleUrl = `${siteBaseUrl}${blogPathPrefix}/${slug}`;
  const article = await waitForArticle(articleUrl);
  articleData.push({ slug, articleUrl, article });
}

const [robots, sitemapIndex] = await Promise.all([
  get(`${siteBaseUrl}/robots.txt`),
  get(`${siteBaseUrl}/sitemap-index.xml`),
]);

let sitemapBody = sitemapIndex.status === 200 ? sitemapIndex.body : '';
if (sitemapIndex.status !== 200) {
  const plain = await get(`${siteBaseUrl}/sitemap.xml`);
  sitemapBody = plain.status === 200 ? plain.body : '';
} else {
  const childUrls = [...sitemapIndex.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const childUrl of childUrls) {
    const child = await get(childUrl);
    if (child.status === 200) sitemapBody += child.body;
  }
}

const blogIndex = await get(`${siteBaseUrl}${blogPathPrefix}`);
const results = [];

for (const { slug, articleUrl, article } of articleData) {
  const html = article.body;

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  const canonicalHref = canonicalMatch?.[0].match(/href=["']([^"']+)["']/i)?.[1] ?? null;
  const robotsMetaMatch = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
  const robotsMetaContent = robotsMetaMatch?.[0].match(/content=["']([^"']+)["']/i)?.[1] ?? '';

  // robots.txt に記事パスを明示的に拒否する Disallow がないか確認する。
  const disallowed = robots.status === 200
    && robots.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^Disallow:/i.test(line))
      .map((line) => line.replace(/^Disallow:\s*/i, '').trim())
      .some((rule) => rule !== '' && `${blogPathPrefix}/${slug}`.startsWith(rule));

  const sitemapHits = [...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].replace(/\/$/, ''))
    .filter((loc) => loc === articleUrl.replace(/\/$/, ''));

  const checks = {
    articleHttp200: article.status === 200,
    listedOnBlogIndex: blogIndex.status === 200 && blogIndex.body.includes(`${blogPathPrefix}/${slug}`),
    inSitemap: sitemapHits.length > 0,
    canonicalMatches: canonicalHref
      ? canonicalHref.replace(/\/$/, '') === articleUrl.replace(/\/$/, '')
      : false,
    noIndexAbsent: !/noindex/i.test(robotsMetaContent),
    // robots.txt が無い(404)場合はクロール全許可を意味するため合格とする。
    // 取得自体に失敗した場合(status 0 等)は判定できないので不合格にする。
    robotsTxtAllows: robots.status === 404 || (robots.status === 200 && !disallowed),
    // sitemap 内に同一記事URLが複数現れないこと。
    noDuplicateUrl: sitemapHits.length <= 1,
  };

  const ok = Object.values(checks).every(Boolean);
  results.push({ slug, url: articleUrl, status: article.status, checks, ok });
  console.log(`${ok ? 'OK  ' : 'NG  '} ${slug} ${JSON.stringify(checks)}`);
}

const payload = {
  version: 1,
  verifiedAt: new Date().toISOString(),
  siteBaseUrl,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  // ルーティンはこれを読み、ok:true の記事だけ Notion を「公開済」へ同期する。
  results,
};

// 出力先ディレクトリが無いリポジトリでも動くようにする。
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`本番確認に失敗した記事があります: ${failed.map((f) => f.slug).join(', ')}`);
  process.exit(1);
}
