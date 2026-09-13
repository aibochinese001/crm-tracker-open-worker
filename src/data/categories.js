import { getKVJson, putKVJson } from './kv.js';

const KEY = 'categories';

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<string[]>}
 */
export async function getCategories(env) {
  return (await getKVJson(env, KEY)) || [];
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} category
 */
export async function addCategory(env, category) {
  const trimmed = category.trim();
  if (!trimmed) return;
  const list = await getCategories(env);
  if (!list.includes(trimmed)) {
    list.push(trimmed);
    list.sort();
    await putKVJson(env, KEY, list);
  }
}
