# `@harperfast/vite-plugin`

## Overview

A lightweight Harper application integration that mounts a Vite dev server in **middleware mode** and forwards HTTP requests to it.

This allows Vite-powered frontends or components to be served directly inside a Harper application during development.

This plugin:

- Creates a Vite dev server scoped to a Harper application directory
- Runs Vite in **middleware mode**
- Forwards incoming Harper HTTP requests to Vite's Connect middleware
- Enables seamless local development of Vite apps inside Harper

This is intended for **development workflows**, not production builds.

## How It Works

1. Harper loads your application and calls `handleApplication`
2. A Vite dev server is created with:
   - `root` set to the application directory
   - `vite.config.js` loaded from that directory
   - `middlewareMode: true`
3. Incoming HTTP requests are forwarded to Vite's middleware stack

## Usage

Install the plugin in your Harper application:

```bash
npm install @harperfast/vite-plugin --save-dev
```

Then, in your Harper applications `config.yaml` paste the plugin:

```yaml
'@harperfast/vite-plugin':
  package: '@harperfast/vite-plugin'
```

Next, open `package.json` and change the "dev" script to:

```
"dev": "harper run .",
```

Your application will now run on [http://localhost:9926](http://localhost:9926/).

## Tools Used

1. [TypeScript](https://www.typescriptlang.org/) for static typing
2. [ESLint](https://eslint.org/) for linting
3. [Prettier](https://prettier.io/) for code formatting
4. [Vite](https://vitejs.dev/) for the development server and middleware
