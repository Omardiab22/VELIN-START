import express from "express";
import cors from "cors";
import fetch from "node-fetch";

/* ============ ENV ============ */
const PORT = process.env.PORT || 8080;
const WUILT_API_KEY = process.env.WUILT_API_KEY;         // من إعدادات Wuilt
const WUILT_STORE_ID = process.env.WUILT_STORE_ID;       // ID متجر Wuilt
const NFC_KEYWORDS = (process.env.NFC_KEYWORDS || "nfc,tag,velin").toLowerCase().split(",");
const GRAPHQL_ENDPOINT = process.env.WUILT_GQL || "https://graphql.wuilt.com";

/* تخزين مؤقت للـ MVP (بدّله لاحقاً بـ DB: Supabase/Firebase) */
const profiles = new Map();  // username -> {username,email,name,mode,message,canActivate}

/* ====== Helpers ====== */
async function wuiltGraphQL(query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WUILT_API_KEY}`
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e=>e.message).join(", "));
  return json.data;
}

/* نجيب آخر الطلبات ونتأكد أن فيه سطر Product فيه كلمة من NFC_KEYWORDS */
const LIST_ORDERS = `
  query ListOrders($storeId: ID!, $connection: OrdersConnectionInput) {
    orders(storeId: $storeId, connection: $connection) {
      nodes {
        id
        createdAt
        orderSerial
        customer { email name }
        items {
          title
          productSnapshot { handle title type }
        }
      }
    }
  }
`;

/* ============ APP ============ */
const app = express();
app.use(cors());
app.use(express.json());

/* 1) فحص الأهلية للشراء (email) */
app.post("/check-eligibility", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase();
    if (!email) return res.status(400).json({ ok:false, reason:"email required" });

    const data = await wuiltGraphQL(LIST_ORDERS, {
      storeId: WUILT_STORE_ID,
      connection: { first: 50, sortBy: "createdAt", sortOrder: "desc" }
    });

    const orders = data?.orders?.nodes || [];
    const bought = orders.some(o =>
      (o.customer?.email || "").toLowerCase() === email &&
      (o.items || []).some(i => {
        const t = (i.title || "").toLowerCase();
        const h = (i.productSnapshot?.handle || "").toLowerCase();
        return NFC_KEYWORDS.some(k => t.includes(k) || h.includes(k));
      })
    );

    res.json({ ok:true, eligible: bought });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, reason:"server_error" });
  }
});

/* 2) حفظ/تحديث بروفايل (ربط username + رسالة + mode) */
app.post("/profile/upsert", (req, res) => {
  const { username, email, name, mode, message } = req.body || {};
  if (!username) return res.status(400).json({ ok:false, reason:"username required" });
  const u = username.toLowerCase();
  const prev = profiles.get(u) || {};
  profiles.set(u, {
    username: u,
    email: (email || prev.email || "").toLowerCase(),
    name: name ?? prev.name ?? "",
    mode: mode ?? prev.mode ?? "generic",
    message: message ?? prev.message ?? "",
    canActivate: prev.canActivate ?? false
  });
  res.json({ ok:true });
});

/* 3) جلب بروفايل للعرض */
app.get("/profile/get", (req, res) => {
  const u = String(req.query.username || "").toLowerCase();
  const profile = profiles.get(u);
  if (!profile) return res.status(404).json({ ok:false, reason:"not_found" });
  res.json(profile);
});

/* 4) Webhook من Wuilt (اختياري): علّم canActivate=true عند شراء NFC */
app.post("/webhooks/wuilt", (req, res) => {
  // استقبل payload حسب ما تضبطه في لوحة Wuilt (حدث إنشاء أوردر مثلاً)
  const body = req.body || {};
  try {
    const order = body.order || body.payload?.order;
    const email = (order?.customer?.email || "").toLowerCase();
    if (email) {
      // فعّل أي بروفايل مرتبط بنفس الإيميل
      for (const [key, prof] of profiles) {
        if (prof.email === email) profiles.set(key, { ...prof, canActivate: true });
      }
    }
  } catch (e) { console.error("webhook parse", e); }
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Velin MVP API running on :${PORT}`);
});
