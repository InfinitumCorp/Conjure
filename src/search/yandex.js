// Web search for Conjure Search through Yandex Search API (Yandex Cloud, in Russia).
//
// Signed like the models: the VM's own service account (CONJURE_LLM_AUTH=yandex-vm; the account needs
// the search-api.webSearch.user role) or a fixed key (CONJURE_SEARCH_KEY, scope yc.search-api.execute).
// The folder is CONJURE_SEARCH_FOLDER, else the model folder (CONJURE_LLM_PROJECT).
import { authHeaders } from "../llm-auth.js";
import { decodeEntities } from "./crawl.js";

export const SEARCH_URL = "https://searchapi.api.cloud.yandex.net/v2/web/search";

/** True when this server can search the web. */
export function searchConfigured(env = process.env) {
  if (env.CONJURE_SEARCH === "off") return false;
  return Boolean((env.CONJURE_SEARCH_KEY || env.CONJURE_LLM_AUTH === "yandex-vm") && (env.CONJURE_SEARCH_FOLDER || env.CONJURE_LLM_PROJECT));
}

const strip = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Results from Yandex's XML answer: [{ url, domain, title, snippet }]. */
export function parseYandexXml(xml) {
  const err = /<error[^>]*code="(\d+)"[^>]*>([\s\S]*?)<\/error>/i.exec(xml);
  // Code 15 is "nothing found", not a failure.
  if (err && err[1] !== "15") throw new Error(`Yandex Search: ${strip(err[2])} (${err[1]})`);
  const out = [];
  for (const [, doc] of xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/gi)) {
    const url = strip(/<url>([\s\S]*?)<\/url>/i.exec(doc)?.[1]);
    if (!url) continue;
    const passages = [...doc.matchAll(/<passage>([\s\S]*?)<\/passage>/gi)].map((m) => strip(m[1]));
    const headline = strip(/<headline>([\s\S]*?)<\/headline>/i.exec(doc)?.[1]);
    out.push({
      url,
      domain: strip(/<domain>([\s\S]*?)<\/domain>/i.exec(doc)?.[1]) || hostOf(url),
      title: strip(/<title>([\s\S]*?)<\/title>/i.exec(doc)?.[1]) || url,
      snippet: [headline, ...passages].filter(Boolean).join(" … ").slice(0, 600),
    });
  }
  return out;
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * One web search. Resolves to up to `count` results.
 * @param {string} query
 * @param {{ count?: number, lang?: string, fresh?: boolean, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [o]
 */
export async function yandexSearch(query, { count = 10, lang, fresh = false, fetchImpl = fetch, env = process.env, signal } = {}) {
  const folderId = env.CONJURE_SEARCH_FOLDER || env.CONJURE_LLM_PROJECT;
  // Russian-language questions search Yandex.ru (region Russia); anything else searches yandex.com worldwide.
  const ru = (lang ?? (/[а-яё]/i.test(query) ? "ru" : "en")) === "ru";
  const body = {
    query: {
      searchType: ru ? "SEARCH_TYPE_RU" : "SEARCH_TYPE_COM",
      queryText: query.slice(0, 400),
      familyMode: "FAMILY_MODE_MODERATE",
      fixTypoMode: "FIX_TYPO_MODE_ON",
    },
    sortSpec: { sortMode: fresh ? "SORT_MODE_BY_TIME" : "SORT_MODE_BY_RELEVANCE" },
    groupSpec: { groupMode: "GROUP_MODE_FLAT", groupsOnPage: String(Math.max(1, Math.min(30, count))), docsInGroup: "1" },
    maxPassages: "3",
    ...(ru ? { region: "225" } : {}),
    l10n: ru ? "LOCALIZATION_RU" : "LOCALIZATION_EN",
    folderId,
    responseFormat: "FORMAT_XML",
  };
  const res = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(env.CONJURE_SEARCH_KEY || "", { vm: !env.CONJURE_SEARCH_KEY })) },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Yandex Search answered ${res.status}: ${out?.message || out?.error?.message || "error"}`);
  if (typeof out?.rawData !== "string") throw new Error("Yandex Search sent no results");
  return parseYandexXml(Buffer.from(out.rawData, "base64").toString("utf8")).slice(0, count);
}
