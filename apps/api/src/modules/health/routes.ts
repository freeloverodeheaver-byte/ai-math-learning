import type { FastifyPluginAsync } from "fastify";

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ status: "ok", service: "api" }));
};
