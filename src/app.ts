import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { initDb } from "./db/database";
import { applicationRouter } from "./routes/applications.route";
import { webhookRouter } from "./routes/webhook.route";
import { adminRouter } from "./routes/admin.route";
import { errorMiddleware } from "./middleware/error.middleware";
import { checkDisbursementTimeouts } from "./services/disbursement.service";

const app = express();

app.use(express.json());

app.use("/applications", applicationRouter);
app.use("/webhook", webhookRouter);
app.use("/admin", adminRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Global error handler — MUST be last
app.use(errorMiddleware);

const PORT = Number(process.env.PORT) || 3000;

initDb();

// Check for disbursement timeouts every 5 minutes
setInterval(() => {
  checkDisbursementTimeouts();
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Admin:  http://localhost:${PORT}/admin/applications`);
  console.log(`💡 Health: http://localhost:${PORT}/health`);
});

export default app;
