import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../middleware/validate";
import {
  googleHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
  signupHandler,
} from "./auth.controller";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1).max(80).optional()
  ),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

router.post("/signup", validateBody(signupSchema), signupHandler);
router.post("/login", validateBody(loginSchema), loginHandler);
router.post("/google", googleHandler);
router.post("/logout", logoutHandler);
router.post("/refresh", refreshHandler);

export default router;
