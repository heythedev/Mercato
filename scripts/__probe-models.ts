// List models available to this Moonshot account.
import "dotenv/config";

async function main() {
  const key = process.env.MOONSHOT_KEY ?? process.env.KIMI_API_KEY ?? "";
  const base = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  console.log("status:", res.status);
  const json = (await res.json()) as { data?: { id: string }[] };
  for (const m of json.data ?? []) console.log("-", m.id);
}
main().catch((e) => { console.error(e); process.exit(1); });
