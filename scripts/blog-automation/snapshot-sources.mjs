// 公式情報の取得と差分検出だけを行う。
//
// Claude Code のクラウドルーティンは egress プロキシにより官公庁ドメインへ到達できないため、
// ネットワークを使う工程だけをこのスクリプトへ切り出し、GitHub Actions 上で実行する。
// 記事化の判断（企業の行動に影響する変更かどうか）と Notion への保存はルーティン側が担当する。
// このスクリプトは判断を一切行わず、変更の事実だけを data/subsidy-source-changes.json に書き出す。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const configPath = process.env.SUBSIDY_SOURCE_CONFIG || 'config/subsidy-sources.json';
const statePath = process.env.SUBSIDY_SOURCE_STATE || 'data/subsidy-source-state.json';
const baselinePath = process.env.SUBSIDY_SOURCE_BASELINE || 'data/chatgpt-subsidy-source-state.json';
const changesPath = process.env.SUBSIDY_SOURCE_CHANGES || 'data/subsidy-source-changes.json';
const maxStoredChars = 30000;
const requestTimeoutMs = 30000;

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

// generate-update-draft.mjs と同じ正規化。スナップショットの互換性を保つため変更しないこと。
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      'User-Agent': 'CIZA-Subsidy-Update-Monitor/1.0 (+https://hojokin.ciza.co.jp)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
  const html = await response.text();
  const content = normalizeHtml(html);
  // 取得できたはずのページが極端に短い場合は、取得失敗（JS描画・エラーページ等）とみなす。
  if (content.length < 200) throw new Error(`${source.name}: fetched content is unexpectedly short`);
  return { content, hash: sha256(content), finalUrl: response.url };
}

const config = await readJson(configPath, null);
if (!config) throw new Error(`${configPath} が見つかりません`);

const sources = (config.sources || []).filter((source) => source.enabled !== false);
const state = await readJson(statePath, { version: 1, updatedAt: null, sources: {} });
if (!state.sources) state.sources = {};

// 初回のみ、ChatGPT 運用時代のベースラインを引き継ぐ。
//
// 注意: 旧ベースラインの content は人間可読の要約（例「第1回公募: 応募締切2026-10-30」）であり、
// 本スクリプトが保存する正規化HTMLとは形式が異なる。そのままハッシュ比較すると全件が
// 「変更あり」と誤検知するため、seeded フラグを立てて初回は差分判定の対象から外す。
// 旧要約は previousSummary として残し、ルーティン側が文脈確認に使えるようにする。
let seededFromBaseline = 0;
if (Object.keys(state.sources).length === 0) {
  const baseline = await readJson(baselinePath, null);
  if (baseline?.sources) {
    for (const [id, entry] of Object.entries(baseline.sources)) {
      state.sources[id] = {
        ...entry,
        seeded: true,
        previousSummary: entry.content ?? '',
      };
      seededFromBaseline += 1;
    }
  }
}

const now = new Date();
const changes = [];
const errors = [];
let initialized = 0;
let unchanged = 0;

for (const source of sources) {
  let fetched;
  try {
    fetched = await fetchSource(source);
  } catch (error) {
    // 取得失敗は記事化対象にしない。前回の状態をそのまま保持する。
    errors.push({ id: source.id, name: source.name, url: source.url, message: error.message });
    continue;
  }

  const previous = state.sources[source.id];

  // 未登録、または旧ベースライン由来（ハッシュ形式が非互換）の場合はベースライン保存のみ。
  // 仕様「初回取得はベースライン保存だけ行い、記事は作らない」に一致する。
  if (!previous || previous.seeded) {
    state.sources[source.id] = {
      name: source.name,
      url: source.url,
      role: source.role,
      region: source.region,
      finalUrl: fetched.finalUrl,
      hash: fetched.hash,
      content: fetched.content,
      checkedAt: now.toISOString(),
      // 旧運用時点の要約を1周期だけ残す（ルーティンが移管前後の文脈確認に使える）。
      ...(previous?.previousSummary ? { previousSummary: previous.previousSummary } : {}),
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

  // 変更あり。判断はルーティン側で行うため、前後の内容をそのまま記録する。
  changes.push({
    id: source.id,
    name: source.name,
    url: source.url,
    finalUrl: fetched.finalUrl,
    role: source.role,
    region: source.region,
    // 発見用途の横断ページ（ミラサポplus等）は最終出典にしない。ルーティン側の判断材料。
    articleEligible: source.articleEligible !== false,
    previousHash: previous.hash,
    previousContent: previous.content ?? '',
    currentHash: fetched.hash,
    currentContent: fetched.content,
    detectedAt: now.toISOString(),
  });

  state.sources[source.id] = {
    ...previous,
    name: source.name,
    url: source.url,
    role: source.role,
    region: source.region,
    finalUrl: fetched.finalUrl,
    hash: fetched.hash,
    content: fetched.content,
    checkedAt: now.toISOString(),
  };
}

state.version = state.version || 1;
state.snapshotMethod = 'relevant-text-v1';
state.updatedAt = now.toISOString();

await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
await fs.writeFile(
  changesPath,
  `${JSON.stringify(
    {
      version: 1,
      generatedAt: now.toISOString(),
      // ルーティンはこの pendingReview を見て記事化を判断し、処理後に false へ落とす。
      pendingReview: changes.length > 0,
      changes,
      errors,
    },
    null,
    2,
  )}\n`,
);

console.log(
  [
    `sources=${sources.length}`,
    `changed=${changes.length}`,
    `unchanged=${unchanged}`,
    `initialized=${initialized}`,
    `seededFromBaseline=${seededFromBaseline}`,
    `errors=${errors.length}`,
  ].join(' '),
);
for (const change of changes) console.log(`  changed: ${change.name} (${change.url})`);
for (const error of errors) console.log(`  error:   ${error.name}: ${error.message}`);
