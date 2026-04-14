import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import multer from "multer";
import FormData from "form-data";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_FILE_API_URL = "https://api.monday.com/v2/file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static("public"));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const config = {
  token: process.env.MONDAY_TOKEN,
  boardId: process.env.MONDAY_BOARD_ID,
  groups: {
    newApplication: process.env.MONDAY_NEW_APPLICATION_GROUP_ID,
    awarded: process.env.MONDAY_AWARDED_GROUP_ID,
    awardedKiosk: process.env.MONDAY_AWARDED_KIOSK_GROUP_ID
  },
  columns: {
    name: process.env.MONDAY_NAME_COLUMN_ID || "name",
    category: process.env.MONDAY_CATEGORY_COLUMN_ID,
    status: process.env.MONDAY_STATUS_COLUMN_ID,
    requestAmount: process.env.MONDAY_REQUEST_AMOUNT_COLUMN_ID,
    impactMedia: process.env.MONDAY_IMPACT_MEDIA_COLUMN_ID,
    impactDescription: process.env.MONDAY_IMPACT_DESCRIPTION_COLUMN_ID,
    date: process.env.MONDAY_DATE_COLUMN_ID
  }
};

function ensureConfig() {
  const missing = [
    ["MONDAY_TOKEN", config.token],
    ["MONDAY_BOARD_ID", config.boardId],
    ["MONDAY_NEW_APPLICATION_GROUP_ID", config.groups.newApplication],
    ["MONDAY_AWARDED_GROUP_ID", config.groups.awarded],
    ["MONDAY_AWARDED_KIOSK_GROUP_ID", config.groups.awardedKiosk],
    ["MONDAY_CATEGORY_COLUMN_ID", config.columns.category],
    ["MONDAY_STATUS_COLUMN_ID", config.columns.status],
    ["MONDAY_REQUEST_AMOUNT_COLUMN_ID", config.columns.requestAmount],
    ["MONDAY_IMPACT_MEDIA_COLUMN_ID", config.columns.impactMedia],
    ["MONDAY_IMPACT_DESCRIPTION_COLUMN_ID", config.columns.impactDescription],
    ["MONDAY_DATE_COLUMN_ID", config.columns.date]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.map(([name]) => name).join(", ")}`
    );
  }
}

async function makeMondayRequest(query, variables = {}) {
  ensureConfig();

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(`Monday request failed with status ${response.status}`);
  }

  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }

  return json.data;
}

function getColumnById(item, columnId) {
  return item.column_values.find((col) => col.id === columnId);
}

async function fetchBoardItems() {
  const boardQuery = `
    query GetBoardItems($boardId: [ID!]) {
      boards(ids: $boardId) {
        items_page(limit: 100) {
          items {
            id
            name
            group {
              id
              title
            }
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const boardData = await makeMondayRequest(boardQuery, {
    boardId: [config.boardId]
  });

  const board = boardData?.boards?.[0];
  const items = board?.items_page?.items || [];

  if (!board) {
    throw new Error("Board not found.");
  }

  const itemIds = items.map((item) => String(item.id));

  if (itemIds.length === 0) {
    return [];
  }

  const assetsQuery = `
    query GetItemAssets($itemIds: [ID!]) {
      items(ids: $itemIds) {
        id
        assets {
          id
          name
          public_url
          url
        }
      }
    }
  `;

  const assetsData = await makeMondayRequest(assetsQuery, {
    itemIds
  });

  const assetsByItemId = new Map(
    (assetsData?.items || []).map((item) => [String(item.id), item.assets || []])
  );

  return items.map((item) => ({
    ...item,
    assets: assetsByItemId.get(String(item.id)) || []
  }));
}

function transformItemToStory(item) {
  const impactDescriptionCol = getColumnById(item, config.columns.impactDescription);
  const categoryCol = getColumnById(item, config.columns.category);
  const requestAmountCol = getColumnById(item, config.columns.requestAmount);

  const title = item.name || "Untitled Story";

  const descriptionRaw = impactDescriptionCol?.text || "";
  const description =
    descriptionRaw.length > 240
      ? `${descriptionRaw.slice(0, 240).trim()}...`
      : descriptionRaw || "No impact description available.";

  const badge = categoryCol?.text || "Community Impact";

  const rawAmount = requestAmountCol?.text || "";
  const numericAmount = Number(String(rawAmount).replace(/[$,]/g, ""));
  const grantAmount = Number.isFinite(numericAmount) ? numericAmount : 0;

  // ── Resolve image URL ─────────────────────────────────────────────────
  // Pass the asset ID to the proxy route so it can fetch a fresh
  // public_url from the Monday API on every request — avoiding the
  // 1-hour expiry on S3 signed URLs.
  let image = "/images/picture-bcf-3.jpg";

  if (item.assets?.length > 0) {
    const asset = item.assets[0];
    if (asset.id) {
      image = `/api/asset-proxy?assetId=${asset.id}`;
    }
  }

  return {
    id: item.id,
    groupId: item.group?.id || "",
    groupTitle: item.group?.title || "",
    title,
    description,
    image,
    badge,
    grantAmount
  };
}

function filterStoriesByGroupId(items, groupId) {
  return items
    .filter((item) => item.group?.id === groupId)
    .map(transformItemToStory);
}

async function createGrantItem({ orgName, grantDate, category, amount, summary }) {
  const columnValues = JSON.stringify({
    [config.columns.category]: category,
    [config.columns.status]: { label: "New" },
    [config.columns.requestAmount]: Number(amount),
    [config.columns.impactDescription]: summary,
    [config.columns.date]: { date: grantDate }
  });

  const query = `
    mutation CreateGrantItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  const data = await makeMondayRequest(query, {
    boardId: config.boardId,
    groupId: config.groups.newApplication,
    itemName: orgName,
    columnValues
  });

  return data.create_item.id;
}

async function uploadFileToMonday(itemId, file) {
  const query = `
    mutation ($file: File!) {
      add_file_to_column(
        item_id: ${itemId},
        column_id: "${config.columns.impactMedia}",
        file: $file
      ) {
        id
      }
    }
  `;

  const form = new FormData();
  form.append("query", query);
  form.append("variables[file]", file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype
  });

  const response = await fetch(MONDAY_FILE_API_URL, {
    method: "POST",
    headers: {
      Authorization: config.token,
      ...form.getHeaders()
    },
    body: form
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(`File upload failed with status ${response.status}`);
  }

  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }

  return json.data;
}

// ── Page routes ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "story.html"));
});

app.get("/story", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "story.html"));
});

app.get("/kiosk", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kiosk.html"));
});

app.get("/grant-form", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "grant-form.html"));
});

// ── Image proxy route ──────────────────────────────────────────────────────
// Fetches a fresh public_url from Monday API for the given assetId,
// then fetches and streams the image. This avoids the 1-hour S3 expiry
// problem by always getting a fresh signed URL at request time.
app.get("/api/asset-proxy", async (req, res) => {
  const { assetId } = req.query;

  if (!assetId) {
    return res.status(400).send("Missing assetId parameter");
  }

  try {
    // Step 1: fetch a fresh public_url from Monday API
    const assetQuery = `
      query GetAsset($assetId: [ID!]!) {
        assets(ids: $assetId) {
          id
          public_url
        }
      }
    `;

    const assetData = await makeMondayRequest(assetQuery, {
      assetId: [assetId]
    });

    const freshUrl = assetData?.assets?.[0]?.public_url;

    if (!freshUrl) {
      console.error(`[Asset Proxy] No public_url found for assetId ${assetId}`);
      return res.status(404).send("Asset not found");
    }

    // Step 2: fetch the image from the fresh S3 URL
    const imageResponse = await fetch(freshUrl);

    if (!imageResponse.ok) {
      console.error(`[Asset Proxy] S3 fetch failed: ${imageResponse.status} for ${freshUrl}`);
      return res.status(imageResponse.status).send("Failed to fetch image");
    }

    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", contentType);
    // Cache for 45 minutes — safely within the 1-hour S3 expiry window
    res.set("Cache-Control", "public, max-age=2700");

    const buffer = await imageResponse.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[Asset Proxy] Error:", err);
    res.status(500).send("Asset proxy error");
  }
});

// ── API routes ─────────────────────────────────────────────────────────────

app.post("/submit-grant", upload.single("impact-media"), async (req, res) => {
  try {
    const orgName = req.body["org-name"]?.trim();
    const grantDate = req.body["grant-date"];
    const category = req.body["grant-category"]?.trim();
    const amount = req.body["amount"];
    const summary = req.body["summary"]?.trim();

    if (!orgName || !grantDate || !category || !amount || !summary) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    const itemId = await createGrantItem({
      orgName,
      grantDate,
      category,
      amount,
      summary
    });

    if (req.file) {
      await uploadFileToMonday(itemId, req.file);
    }

    return res.json({
      success: true,
      message: "Grant application submitted successfully.",
      itemId
    });
  } catch (err) {
    console.error("Grant submission error:", err);

    return res.status(500).json({
      error: "Failed to submit grant application.",
      details: err.message || "Unknown server error"
    });
  }
});

app.get("/api/storypage-stories", async (req, res) => {
  try {
    const items = await fetchBoardItems();
    const stories = filterStoriesByGroupId(items, config.groups.awarded);
    res.json(stories);
  } catch (err) {
    console.error("Story page route error:", err);
    res.status(500).json({
      error: "Failed to fetch story page stories",
      details: err.message
    });
  }
});

app.get("/api/kiosk-stories", async (req, res) => {
  try {
    const items = await fetchBoardItems();
    const stories = filterStoriesByGroupId(items, config.groups.awardedKiosk);
    res.json(stories);
  } catch (err) {
    console.error("Kiosk route error:", err);
    res.status(500).json({
      error: "Failed to fetch kiosk stories",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});