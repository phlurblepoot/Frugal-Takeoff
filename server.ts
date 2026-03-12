import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import { createServer } from "http";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const DATA_DIR = process.env.STORAGE_PATH || path.join(process.cwd(), "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const TEMPLATES_FILE = path.join(DATA_DIR, "templates.json");

async function ensureDirs() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  try {
    await fs.access(TEMPLATES_FILE);
  } catch {
    await fs.writeFile(TEMPLATES_FILE, "[]", "utf-8");
  }
}

async function startServer() {
  await ensureDirs();

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  app.use(express.json({ limit: "50mb" }));

  // API Routes
  app.get("/api/projects", async (req, res) => {
    try {
      const files = await fs.readdir(PROJECTS_DIR);
      const projects = [];
      for (const file of files) {
        if (file.endsWith(".json")) {
          const data = await fs.readFile(path.join(PROJECTS_DIR, file), "utf-8");
          projects.push(JSON.parse(data));
        }
      }
      projects.sort((a, b) => b.createdAt - a.createdAt);
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const data = await fs.readFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), "utf-8");
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(404).json({ error: "Project not found" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const project = req.body;
      await fs.writeFile(path.join(PROJECTS_DIR, `${project.id}.json`), JSON.stringify(project, null, 2), "utf-8");
      res.json({ success: true });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  app.put("/api/projects/:id", async (req, res) => {
    try {
      const project = req.body;
      
      try {
        const oldData = await fs.readFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), "utf-8");
        const oldProject = JSON.parse(oldData);
        
        const newImageIds = new Set([
          ...(project.pages?.map((p: any) => p.imageId) || []),
          ...(project.printouts?.map((p: any) => p.fileId) || [])
        ]);

        const oldImageIds = [
          ...(oldProject.pages?.map((p: any) => p.imageId) || []),
          ...(oldProject.printouts?.map((p: any) => p.fileId) || [])
        ];

        for (const imgId of oldImageIds) {
          if (!newImageIds.has(imgId)) {
            await fs.unlink(path.join(IMAGES_DIR, `${imgId}.txt`)).catch(() => {});
          }
        }
      } catch (e) {
        // Ignore if old project doesn't exist
      }

      await fs.writeFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), JSON.stringify(project, null, 2), "utf-8");
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ error: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      const data = await fs.readFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), "utf-8");
      const project = JSON.parse(data);
      
      const imageIds = [
        ...(project.pages?.map((p: any) => p.imageId) || []),
        ...(project.printouts?.map((p: any) => p.fileId) || [])
      ];
      
      for (const imgId of imageIds) {
        await fs.unlink(path.join(IMAGES_DIR, `${imgId}.txt`)).catch(() => {});
      }
      
      await fs.unlink(path.join(PROJECTS_DIR, `${req.params.id}.json`));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  app.get("/api/images/:id", async (req, res) => {
    try {
      const data = await fs.readFile(path.join(IMAGES_DIR, `${req.params.id}.txt`), "utf-8");
      res.json({ data });
    } catch (error) {
      res.status(404).json({ error: "Image not found" });
    }
  });

  app.post("/api/images", async (req, res) => {
    try {
      const { id, data } = req.body;
      await fs.writeFile(path.join(IMAGES_DIR, `${id}.txt`), data, "utf-8");
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving image:", error);
      res.status(500).json({ error: "Failed to save image" });
    }
  });

  app.get("/api/templates", async (req, res) => {
    try {
      const data = await fs.readFile(TEMPLATES_FILE, "utf-8");
      res.json(JSON.parse(data));
    } catch (error) {
      res.json([]);
    }
  });

  app.post("/api/templates", async (req, res) => {
    try {
      const t = req.body;
      const data = await fs.readFile(TEMPLATES_FILE, "utf-8");
      let templates = JSON.parse(data);
      
      const index = templates.findIndex((x: any) => x.id === t.id);
      if (index >= 0) {
        templates[index] = t;
      } else {
        templates.push(t);
      }
      
      await fs.writeFile(TEMPLATES_FILE, JSON.stringify(templates, null, 2), "utf-8");
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving template:", error);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  app.delete("/api/templates/:id", async (req, res) => {
    try {
      const data = await fs.readFile(TEMPLATES_FILE, "utf-8");
      let templates = JSON.parse(data);
      templates = templates.filter((x: any) => x.id !== req.params.id);
      await fs.writeFile(TEMPLATES_FILE, JSON.stringify(templates, null, 2), "utf-8");
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting template:", error);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // WebSocket Logic
  const users: Record<string, { id: string; name: string; pageId: string; cursor: { x: number; y: number } | null; color: string }> = {};

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-page", ({ pageId, name, color }) => {
      users[socket.id] = { id: socket.id, name, pageId, cursor: null, color };
      socket.join(pageId);
      
      // Notify others in the room
      const roomUsers = Object.values(users).filter(u => u.pageId === pageId);
      io.to(pageId).emit("room-users", roomUsers);
    });

    socket.on("cursor-move", ({ x, y }) => {
      const user = users[socket.id];
      if (user) {
        user.cursor = { x, y };
        socket.to(user.pageId).emit("user-cursor", { id: socket.id, cursor: { x, y } });
      }
    });

    socket.on("measurement-update", ({ pageId, action, measurement }) => {
      socket.to(pageId).emit("measurement-sync", { action, measurement });
    });

    socket.on("project-update", ({ projectId }) => {
      socket.broadcast.emit("project-sync", { projectId });
    });

    socket.on("disconnect", () => {
      const user = users[socket.id];
      if (user) {
        const pageId = user.pageId;
        delete users[socket.id];
        const roomUsers = Object.values(users).filter(u => u.pageId === pageId);
        io.to(pageId).emit("room-users", roomUsers);
      }
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = 3000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
