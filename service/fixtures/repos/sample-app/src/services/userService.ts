import { createHash } from 'node:crypto';
import type { Queryable } from '../db/client.js';
import { findUserByApiKeyHash, updateUserName, type User } from '../db/repositories/userRepository.js';
import { NotFoundError } from '../errors.js';

/** SHA-256 hex digest of an API key. Keys are never stored in plain text. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function createUserService(db: Queryable) {
  return {
    authenticate(apiKey: string): Promise<User | null> {
      return findUserByApiKeyHash(db, hashApiKey(apiKey));
    },
    async rename(userId: string, name: string): Promise<User> {
      const user = await updateUserName(db, userId, name);
      if (!user) throw new NotFoundError('user');
      return user;
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
