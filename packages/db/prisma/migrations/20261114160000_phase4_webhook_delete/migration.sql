-- Phase 4 adds explicit webhook deletion monitoring to the Anti-Nuke catalog.
ALTER TYPE "AntiNukeAction" ADD VALUE IF NOT EXISTS 'WEBHOOK_DELETE';
