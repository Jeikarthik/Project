import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { documentId, fileUrl } = await req.json();
    if (!documentId || !fileUrl) {
      return new Response(
        JSON.stringify({ error: "Document ID and file URL are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 0: Update document to processing
    await supabaseClient
      .from("documents")
      .update({ status: "processing" })
      .eq("id", documentId);

    // Step 1: Download the file from fileUrl
    const fileResponse = await fetch(fileUrl);
    const fileBlob = await fileResponse.blob();
    const fileName = fileUrl.split("/").pop() || "uploaded_file";
    const file = new File([fileBlob], fileName);

    // Step 2: Send file to FastAPI backend
    const formData = new FormData();
    formData.append("file", file);

    const backendResponse = await fetch("http://127.0.0.1:8000/process-document", {
      method: "POST",
      body: formData,
    });

    if (!backendResponse.ok) {
      const err = await backendResponse.json();
      throw new Error(err.error || "Backend processing failed");
    }

    const result = await backendResponse.json();

    // Step 3: Update Supabase with backend results
    await supabaseClient
      .from("documents")
      .update({
        status: "completed",
        ocr_text: result.cleaned_text_excerpt,
        classification: result.assigned,
        summary: result.summary,
        deadlines: result.deadlines,
      })
      .eq("id", documentId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Document processed successfully",
        documentId,
        ocrText: result.cleaned_text_excerpt,
        classification: result.assigned,
        summary: result.summary,
        deadlines: result.deadlines,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error processing document:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
