-- Phase 9: separate AES-GCM IV and auth tag for the refresh token so the
-- access and refresh tokens never share a nonce.

ALTER TABLE "oauth_credentials"
  ADD COLUMN "refreshIv" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "refreshAuthTag" TEXT NOT NULL DEFAULT '';
