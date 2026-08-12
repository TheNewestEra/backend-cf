import tsParser from "@typescript-eslint/parser";
import neverthrow from "eslint-plugin-neverthrow";

export default [
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {neverthrow},
        rules: {
            "neverthrow/must-use-result": "error",
        },
    },
];
