import express from 'express';
import { z } from 'zod';
import type { UserService } from '../../services/userService.js';
import { currentUser } from '../middleware/auth.js';

export const RenameUserBody = z.object({
  name: z.string().trim().min(1).max(120),
});

export function createUsersRouter(users: UserService): express.Router {
  const router = express.Router();

  router.get('/me', (_req, res) => {
    res.json({ user: currentUser(res) });
  });

  router.patch('/me', async (req, res, next) => {
    try {
      const body = RenameUserBody.parse(req.body);
      const user = await users.rename(currentUser(res).id, body.name);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
