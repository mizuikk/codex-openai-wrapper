import { defineConfig } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([{
    extends: compat.extends("plugin:@typescript-eslint/recommended"),
    rules: {
        // Use TS rule only (disable base)
        "no-unused-vars": "off",

        // Allow explicit any in this project to reduce noise
        "@typescript-eslint/no-explicit-any": "off",

        // Downgrade unused vars to warning and allow underscore-prefixed ignores
        "@typescript-eslint/no-unused-vars": ["warn", {
            "args": "all",
            "argsIgnorePattern": "^_",
            "varsIgnorePattern": "^_",
            "caughtErrors": "all",
            "caughtErrorsIgnorePattern": "^_",
            "ignoreRestSiblings": true
        }]
    },
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2021,
        sourceType: "module",
    },
}]);