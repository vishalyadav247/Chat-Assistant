import { unauthenticated } from "../shopify.server";

// File uploads via Shopify Files API staged uploads (decision 2026-08-06:
// no app CDN). Used for widget logo/launcher icon (06), FAQ category icons (07),
// store logo (16). Accepts image buffers ≤2MB, returns the hosted CDN url.

const MAX_BYTES = 2 * 1024 * 1024;
// SVG uploads land as GenericFile on Shopify's Files API (contentType FILE —
// MediaImage doesn't accept svg); raster types go through MediaImage.
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

const STAGED_UPLOAD_MUTATION = `#graphql
  mutation ChatconvertStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE_MUTATION = `#graphql
  mutation ChatconvertFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
      }
      userErrors { field message }
    }
  }
`;

const FILE_QUERY = `#graphql
  query ChatconvertFile($id: ID!) {
    node(id: $id) {
      ... on MediaImage { image { url } }
      ... on GenericFile { url }
    }
  }
`;

export async function uploadImage(
  shopDomain: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<string> {
  if (file.bytes.length > MAX_BYTES) {
    throw new Error("file too large (max 2MB)");
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error("unsupported file type (SVG, PNG, JPG or WebP)");
  }
  const isSvg = file.type === "image/svg+xml";

  const { admin } = await unauthenticated.admin(shopDomain);

  // 1. Stage
  const stagedRes = await admin.graphql(STAGED_UPLOAD_MUTATION, {
    variables: {
      input: [
        {
          filename: file.name,
          mimeType: file.type,
          httpMethod: "POST",
          resource: "FILE",
          fileSize: String(file.bytes.length),
        },
      ],
    },
  });
  const staged = (await stagedRes.json()) as {
    data: {
      stagedUploadsCreate: {
        stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const target = staged.data.stagedUploadsCreate.stagedTargets[0];
  const stageErrors = staged.data.stagedUploadsCreate.userErrors;
  if (!target || stageErrors.length > 0) {
    throw new Error(`staged upload failed: ${stageErrors.map((e) => e.message).join("; ")}`);
  }

  // 2. POST bytes to the staged target
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const uploadRes = await fetch(target.url, { method: "POST", body: form });
  if (!uploadRes.ok) {
    throw new Error(`staged upload POST failed: ${uploadRes.status}`);
  }

  // 3. Create the file record
  const createRes = await admin.graphql(FILE_CREATE_MUTATION, {
    variables: {
      files: [{ originalSource: target.resourceUrl, contentType: isSvg ? "FILE" : "IMAGE" }],
    },
  });
  const created = (await createRes.json()) as {
    data: {
      fileCreate: {
        files: Array<{ id: string; image: { url: string } | null; url: string | null }>;
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const errors = created.data.fileCreate.userErrors;
  if (errors.length > 0) {
    throw new Error(`fileCreate failed: ${errors.map((e) => e.message).join("; ")}`);
  }
  const fileNode = created.data.fileCreate.files[0];

  // File URL may be processed asynchronously — poll briefly.
  let url = fileNode.image?.url ?? fileNode.url ?? null;
  for (let attempt = 0; !url && attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const pollRes = await admin.graphql(FILE_QUERY, { variables: { id: fileNode.id } });
    const polled = (await pollRes.json()) as {
      data: { node: { image?: { url: string } | null; url?: string | null } | null };
    };
    url = polled.data.node?.image?.url ?? polled.data.node?.url ?? null;
  }
  if (!url) {
    throw new Error("file processed but no URL available yet — retry shortly");
  }
  return url;
}
