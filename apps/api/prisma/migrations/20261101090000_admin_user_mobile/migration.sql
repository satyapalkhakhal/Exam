-- Admin login codes go to the admin's mobile (SMS) as well as their email.
-- Nullable so existing admins keep signing in by email until a mobile is added;
-- the admin-users API requires it for new admins.
ALTER TABLE "admin_users" ADD COLUMN "mobile" TEXT;
