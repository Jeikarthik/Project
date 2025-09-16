import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Helper: Download file from Supabase Storage
async function downloadFileAsBlob(bucket: string, filePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(filePath);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

// Helper: Send file to Python microservice (change URL to your deployment)
async function callPythonMicroservice(fileBuffer: Uint8Array, fileName: string) {
  const boundary = "CometBoundary" + Math.random().toString().slice(2);
  const encoder = new TextEncoder();

  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;

  const part1 = encoder.encode(payload);
  const part2 = fileBuffer;
  const part3 = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(part1.length + part2.length + part3.length);
  body.set(part1, 0);
  body.set(part2, part1.length);
  body.set(part3, part1.length + part2.length);

  const pythonURL = "http://localhost:8000/process"; // <-- CHANGE THIS!
  const resp = await fetch(pythonURL, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!resp.ok) throw new Error(`Python microservice error: ${resp.status}`);
  return await resp.json();
}

// Main handler: single entry for processing
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Expect { filePath, bucket, documentId } in JSON POST
    const { filePath, bucket, documentId } = await req.json();

    // Step 1: Download the file from Supabase Storage
    let fileBuffer: Uint8Array;
    try {
      fileBuffer = await downloadFileAsBlob(bucket, filePath);
    } catch (error) {
      return new Response(
        JSON.stringify({ error: "File download failed", details: error.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Step 2: Call Python microservice
    let result;
    try {
      result = await callPythonMicroservice(fileBuffer, filePath.split("/").pop() || "document");
      // result: { summary, labels, deadlines, ... }
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Python microservice failed", details: e.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Step 3: Update your DB
    const { error } = await supabase
      .from("documents") // change if your table name is different
      .update({
        summary: result.summary,
        labels: result.labels,
        deadlines: result.deadlines
      })
      .eq("id", documentId);

    if (error) {
      return new Response(
        JSON.stringify({ error: "Could not update DB", details: error.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Step 4: Success response
    return new Response(
      JSON.stringify({ status: "Success", result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || String(error) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
