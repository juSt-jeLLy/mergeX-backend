const mode = (process.env.SERVICE_MODE || "api").toLowerCase();

if (mode === "reposcan") {
  await import("./anthropic.js");
} else {
  await import("./server.js");
}
