import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.get("/", (_, res) => res.send("TMA backend is running"));
app.post("/web-data", (req, res) => {
  console.log("web-data:", req.body);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
