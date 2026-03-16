# ldp-service

Express middleware implementing the [W3C Linked Data Platform (LDP)](http://www.w3.org/2012/ldp) protocol. It handles HTTP operations on LDP resources, performs content negotiation across RDF serialization formats, and delegates persistence to a pluggable storage backend.

Many thanks to Steve Speicher and Sam Padgett for their valuable contribution to LDP and this middleware.

## Build

```bash
npm install
npm run build
```

Requires Node.js >= 22.11.0. The module is written in TypeScript and compiles to ESM (`"type": "module"`).

## Usage

ldp-service exports a factory function that returns an Express sub-application. Mount it in your Express app alongside a storage backend:

```typescript
import express from 'express';
import { ldpService } from 'ldp-service';
import { FsStorage } from 'ldp-service-fs';   // or any StorageService implementation

const app = express();
const env = { appBase: 'http://localhost:3000', context: '/r/' };
const storage = new FsStorage();
await storage.init(env);

app.use(ldpService(env, storage));

app.listen(3000);
```

The `env.context` property (default `'/r/'`) determines the URL path prefix for LDP resources. All requests under that prefix are handled by the middleware.

## What It Does

### LDP Operations

The middleware implements the following HTTP methods on LDP resources:

- **GET** -- Read a resource or container, with dynamically computed containment and membership triples.
- **HEAD** -- Same as GET but returns headers only (no body).
- **POST** -- Create a new resource in a container. Honors the `Slug` header for URI assignment.
- **PUT** -- Update an existing RDF Source or create a resource at a specific URI. Requires `If-Match` for updates.
- **DELETE** -- Remove a resource and clean up containment/membership triples in the parent container.
- **OPTIONS** -- Return allowed methods and LDP headers for a resource.

### Resource Types

- **BasicContainer** (`ldp:BasicContainer`) -- Containment via `ldp:contains`.
- **DirectContainer** (`ldp:DirectContainer`) -- Membership via configurable `ldp:membershipResource`, `ldp:hasMemberRelation`, and `ldp:isMemberOfRelation` properties.
- **RDF Source** (`ldp:RDFSource`) -- Non-container RDF resources.

### Content Negotiation

Supports three RDF serialization formats via the `Accept` and `Content-Type` headers:

- `text/turtle`
- `application/ld+json` (and `application/json`)
- `application/rdf+xml`

### Conditional Requests

- Generates weak `ETag` headers (MD5-based) on responses.
- Supports `If-None-Match` on GET (returns 304 when unchanged).
- Requires `If-Match` on PUT updates (returns 412 on mismatch, 428 if missing).

### Prefer Header

Supports the LDP `Prefer` header for controlling response content:

- `ldp:PreferMinimalContainer` / `ldp:PreferEmptyContainer` -- Omit containment and membership triples.
- `ldp:PreferContainment` -- Explicitly include or omit containment triples.
- `ldp:PreferMembership` -- Explicitly include or omit membership triples.

Returns `Preference-Applied: return=representation` when preferences are honored.

### CORS

The middleware sets CORS headers on all responses, allowing browser-based clients to interact with LDP resources.

## Storage Backends

Persistence is delegated to a `StorageService` interface defined in the `storage-service` package. Three implementations are available:

| Package | Backend | Description |
|---|---|---|
| `ldp-service-fs` | File system | Stores each named graph as a file on disk |
| `ldp-service-mongodb` | MongoDB | Stores graphs in a MongoDB collection |
| `ldp-service-jena` | Apache Jena | Delegates to a Jena Fuseki triplestore via SPARQL |

To use a different backend, implement the `StorageService` interface from `storage-service` and pass it to the `ldpService()` factory.

## Architecture

ldp-service is a protocol-level module. It knows how to speak LDP over HTTP but has no knowledge of OSLC or any domain-specific vocabulary.

The `oslc-service` module builds on top of ldp-service, adding OSLC-specific capabilities such as service provider catalogs, creation factories, selection and creation dialogs, resource previews, and query support. Applications typically use oslc-service rather than ldp-service directly.

The dependency chain is:

```
storage-service  (interface)
      ^
ldp-service  (LDP protocol)
      ^
oslc-service  (OSLC protocol)
      ^
application  (e.g., oslc-server, mrm-server)
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](http://www.apache.org/licenses/LICENSE-2.0) for details.
