# Local Intelligent Speech Assistant

<div align="center">

[![GitHub Release](https://img.shields.io/github/v/release/Lorenzo0111/LISA)](https://github.com/Lorenzo0111/LISA/releases/latest)

</div>

## Introduction

Lisa is a voice assistant that runs on a local machine and keeps your data private. It is designed to be a personal assistant that can help you with your daily tasks. Thanks to a modular design, you can create your own plugins to extend its functionality.

## Features

- [x] Completely offline
- [x] Modular design
- [x] Customizable

## Installation

TODO

## Dashboard

The API doubles as the backend of the LISA dashboard (web, iOS and Android). Copy `.env.example` to `.env`, set `SECRET_TOKEN` and `BETTER_AUTH_SECRET`, then create the tables:

```bash
bunx prisma db push
```

- **Accounts** are handled by [Better Auth](https://better-auth.com) under `/api/auth`. The first person to sign up becomes the administrator and registration closes; everyone else is added from the dashboard. Administrators can change settings, plugins and speakers, members can talk to the assistant and control devices.
- **Web**: export the dashboard and point `DASHBOARD_DIR` at the result to have this server serve it on the same port. A dashboard hosted elsewhere has to be listed in `TRUSTED_ORIGINS`.
- **Speakers**: a voice worker registers itself with `POST /speakers/register` when it starts (its id is `ASSISTANT_CHANNEL`). From then on its wake word, language, models and voice are edited in the dashboard and pushed to it over its notification stream, without restarting it. `worker/.env` only provides the starting values.
- The API is available with and without the `/api` prefix. Workers and other machines authenticate with `SECRET_TOKEN`, people with their session.

---

<p align="center">Lisa by <a href="https://github.com/Lorenzo0111">Lorenzo0111</a></p>
