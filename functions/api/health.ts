
/// <reference types="@cloudflare/workers-types" />
export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
