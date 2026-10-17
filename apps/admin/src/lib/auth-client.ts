"use client";
import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH } from "@/lib/auth-config";

export const authClient = createAuthClient({ basePath: AUTH_BASE_PATH });
