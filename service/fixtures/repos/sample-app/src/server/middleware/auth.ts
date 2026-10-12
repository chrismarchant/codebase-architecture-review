import type express from 'express';
import type { User } from '../../db/repositories/userRepository.js';
import type { UserService } from '../../services/userService.js';
import { UnauthorizedError } from '../../errors.js';

const BEARER = /^Bearer\s+(\S+)$/;

/** Resolves `Authorization: Bearer <key>` to a user and stores it in res.locals.user. */
export function authenticate(users: UserService): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
      if (!token) throw new UnauthorizedError();
      const user = await users.authenticate(token);
      if (!user) throw new UnauthorizedError();
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Returns the user set by authenticate(). Routes behind that middleware can rely on it. */
export function currentUser(res: express.Response): User {
  const user = res.locals.user as User | undefined;
  if (!user) throw new UnauthorizedError();
  return user;
}
