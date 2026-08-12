// 本番サイトが公開されているかを確認し、結果をリポジトリに記録する。
//
// ルーティンは egress プロキシにより自社ドメインへ到達できないため、
// 「サイトが公開されているか」を自分で判定できない。
// このスクリプトが GitHub Actions 上で判定し、ルーティンはその結果を読んで
// 公開処理を実行してよいかを決める。
//
// 2026-08-12 時点で hojokin.ciza.co.jp は Vercel 以外のホストを指しており接続できない。
// DNS が修正されればこのスクリプトが自動的に reachable:true を記録し、公開処理が再開する。

import fs from 'node:fs/promises';
import path from 'node:path';

const siteBaseUrl = (process.env.SITE_BASE_URL || 'https://hojokin.ciza.co.jp').replace(/\/$/, '');
const outputPath = process.env.SITE_STATUS_OUTPUT || 'data/site-status.json';
const requestTimeoutMs = 20000;

async function probe(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CIZA-Site-Status-Check/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return { status: response.status, error: null };
  } catch (error) {
    // DNS 未設定・TLS 失敗・タイムアウトはいずれもここに来る。
    return { status: 0, error: error.message };
  }
}

const [top, robots] = await Promise.all([probe(`${siteBaseUrl}/`), probe(`${siteBaseUrl}/robots.txt`)]);

// トップページが 200 を返すことを「公開されている」の判定条件とする。
const reachable = top.status === 200;

const payload = {
  version: 1,
  checkedAt: new Date().toISOString(),
  siteBaseUrl,
  // ルーティンはこの値が true のときだけ公開処理を実行してよい。
  reachable,
  top: top.status,
  robotsTxt: robots.status,
  note: reachable
    ? '本番サイトへ到達できます。公開処理を実行してよい状態です。'
    : `本番サイトへ到達できません（${top.error ?? `HTTP ${top.status}`}）。公開処理は実行しないでください。`,
};

// 出力先ディレクトリが無いリポジトリでも動くようにする。
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`${siteBaseUrl} reachable=${reachable} top=${top.status} robots=${robots.status}`);
if (top.error) console.log(`  error: ${top.error}`);
