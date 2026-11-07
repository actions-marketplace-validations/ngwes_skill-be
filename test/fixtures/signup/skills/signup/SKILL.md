---
name: signup
description: Use when writing the signup handler of this service. Covers the response codes and the shape of what it answers.
---

# Signup handlers

A signup handler never throws and never reaches for the database itself: it receives what it needs as parameters and answers with `{ status, body }`.

| Case | `status` | `body` |
|---|---|---|
| The input is valid and the email is free | `201` | the user `createUser` returned |
| The email is already registered | `409` | `{ error: 'email-taken' }` |
| The email or the password is invalid | `422` | `{ errors: { email?: string, password?: string } }` |

A password needs at least 12 characters. Call `createUser` only when the input is valid and the email is free.

Never put the password in a log line or in a response.
