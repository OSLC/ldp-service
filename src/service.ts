/*
 * Copyright 2014 IBM Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * service.ts is Express middleware that handles HTTP requests for LDP resources.
 * It is built on an abstract StorageService implementation that can be
 * implemented on different data sources to expose them as LDP resources.
 * The internal, in-memory representation of a resource is an rdflib.js
 * IndexedFormula.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import * as rdflib from 'rdflib';
import { createHash } from 'node:crypto';
import {
  type StorageService,
  type StorageEnv,
  type LdpDocument,
  type MemberBinding,
  ldp,
  media,
} from 'storage-service';

// Convenient rdflib namespaces
const RDF = rdflib.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const LDP = rdflib.Namespace('http://www.w3.org/ns/ldp#');

// Extend Express Request with custom properties
interface LdpRequest extends Request {
  fullURL: string;
  rawBody: string;
}

/**
 * Promisify rdflib.serialize
 */
function serializeRdf(
  subject: rdflib.NamedNode,
  graph: rdflib.IndexedFormula,
  base: string,
  contentType: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    rdflib.serialize(subject, graph, base, contentType, (err, content) => {
      if (err) reject(err);
      else resolve(content ?? '');
    });
  });
}

/**
 * Promisify rdflib.parse
 */
function parseRdf(
  body: string,
  graph: rdflib.IndexedFormula,
  baseURI: string,
  contentType: string
): Promise<rdflib.IndexedFormula> {
  return new Promise((resolve, reject) => {
    rdflib.parse(body, graph, baseURI, contentType, (err, kb) => {
      if (err) reject(err);
      else resolve(kb as rdflib.IndexedFormula);
    });
  });
}

/**
 * Generate an ETag for content using MD5 hash.
 */
export function getETag(content: string): string {
  return 'W/"' + createHash('md5').update(content).digest('hex') + '"';
}

/**
 * Create the LDP Express middleware.
 */
export function ldpService(env: StorageEnv, storage: StorageService): express.Express {
  const appBase = env.appBase;

  // Middleware to create the full URI for the request
  const fullURL = (req: LdpRequest, _res: Response, next: NextFunction): void => {
    req.fullURL = appBase + req.originalUrl;
    next();
  };

  // Middleware to create a UTF8 encoded copy of the original request body
  const rawBody = (req: LdpRequest, _res: Response, next: NextFunction): void => {
    req.rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { req.rawBody += chunk; });
    req.on('end', () => { next(); });
  };

  // Wrap async route handlers to catch errors
  const asyncHandler = (fn: (req: LdpRequest, res: Response, next: NextFunction) => Promise<void>) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req as LdpRequest, res, next).catch(next);
    };
  };

  // add common headers to all responses
  function addHeaders(_req: LdpRequest, res: Response, document: LdpDocument): void {
    let allow = 'GET,HEAD,DELETE,OPTIONS';
    if (document.interactionModel) {
      res.links({
        type: document.interactionModel,
      });
      allow += ',POST';
      res.set('Accept-Post', media.turtle + ',' + media.jsonld + ',' + media.json + ',' + media.rdfxml);
    } else {
      allow += ',PUT';
    }
    res.set('Allow', allow);
  }

  // look at the triples to determine the type of container and its membership pattern
  function updateInteractionModel(document: LdpDocument): void {
    let interactionModel: string = ldp.RDFSource;

    const uriSym = document.sym(document.uri);
    if (document.statementsMatching(uriSym, RDF('type'), LDP('BasicContainer')).length !== 0)
      interactionModel = ldp.BasicContainer;
    if (document.statementsMatching(uriSym, RDF('type'), LDP('DirectContainer')).length !== 0)
      interactionModel = ldp.DirectContainer;
    if (interactionModel === ldp.DirectContainer) {
      const mr = document.any(uriSym, LDP('membershipResource'));
      if (mr) document.membershipResource = mr.value;
      const hmr = document.any(uriSym, LDP('hasMemberRelation'));
      if (hmr) document.hasMemberRelation = hmr.value;
      const imor = document.any(uriSym, LDP('isMemberOfRelation'));
      if (imor) document.isMemberOfRelation = imor.value;
    }

    // don't override an existing interaction model
    if (!document.interactionModel) {
      document.interactionModel = interactionModel;
    }
  }

  // insert membership triples for a membership resource
  async function insertMembership(req: LdpRequest, document: LdpDocument): Promise<{ status: number; preferenceApplied: boolean }> {
    const patterns = document.membershipResourceFor;
    if (!patterns) {
      return { status: 200, preferenceApplied: false };
    }

    if (hasPreferOmit(req, ldp.PreferMembership)) {
      return { status: 200, preferenceApplied: true };
    }

    const preferenceApplied = hasPreferInclude(req, ldp.PreferMembership);

    for (const pattern of patterns) {
      const { status, members } = await storage.getMembershipTriples({ container: pattern.container } as unknown as LdpDocument);
      if (status !== 200) {
        console.log(`Error inserting membership triples: ${status}`);
        return { status, preferenceApplied: false };
      }

      if (members) {
        for (const resource of members) {
          document.add(
            document.sym(document.uri),
            document.sym(pattern.hasMemberRelation!),
            document.sym(resource.member.value),
            document.sym(document.uri)
          );
        }
      }
    }

    return { status: 200, preferenceApplied };
  }

  // insert any dynamically calculated triples
  async function insertCalculatedTriples(req: LdpRequest, document: LdpDocument): Promise<{ status: number; preferenceApplied: boolean }> {
    // insert membership if this is a membership resource
    const memberResult = await insertMembership(req, document);
    if (memberResult.status !== 200) {
      return memberResult;
    }
    let preferenceApplied = memberResult.preferenceApplied;

    // all done if this is not a container
    if (document.interactionModel === null) {
      return { status: 200, preferenceApplied };
    }

    // check if client is asking for a minimal container
    let minimal = false;
    if (hasPreferInclude(req, ldp.PreferMinimalContainer) ||
        hasPreferInclude(req, ldp.PreferEmptyContainer)) {
      preferenceApplied = true;
      minimal = true;
    }

    // include containment?
    let includeContainment: boolean;
    if (hasPreferInclude(req, ldp.PreferContainment)) {
      includeContainment = true;
      preferenceApplied = true;
    } else if (hasPreferOmit(req, ldp.PreferContainment)) {
      includeContainment = false;
      preferenceApplied = true;
    } else {
      includeContainment = !minimal;
    }

    // include membership?
    let includeMembership: boolean;
    if (document.interactionModel === ldp.DirectContainer && document.hasMemberRelation) {
      if (hasPreferInclude(req, ldp.PreferMembership)) {
        includeMembership = true;
        preferenceApplied = true;
      } else if (hasPreferOmit(req, ldp.PreferMembership)) {
        includeMembership = false;
        preferenceApplied = true;
      } else {
        includeMembership = !minimal;
      }
    } else {
      includeMembership = false;
    }

    if (!includeContainment && !includeMembership) {
      return { status: 200, preferenceApplied };
    }

    const { status, members } = await storage.getMembershipTriples(document);
    if (status !== 200) {
      return { status, preferenceApplied: false };
    }

    if (members) {
      for (const member of members) {
        if (includeContainment) {
          document.add(document.sym(document.uri), LDP('contains'), document.sym(member.member.value), document.sym(document.uri));
        }
        if (includeMembership) {
          document.add(document.sym(document.membershipResource!), document.sym(document.hasMemberRelation!), document.sym(member.member.value), document.sym(document.uri));
        }
      }
    }

    return { status: 200, preferenceApplied };
  }

  // append 'path' to the end of a uri
  function addPath(uri: string, path: string): string {
    uri = uri.split('?')[0].split('#')[0];
    if (uri.slice(-1) !== '/') {
      uri += '/';
    }
    // remove special characters from the string (e.g., '/', '..', '?')
    const lastSegment = path.replace(/[^\w\s\-_]/gi, '');
    return uri + encodeURIComponent(lastSegment);
  }

  // generates and reserves a unique URI with base URI 'container'
  async function uniqueURI(container: string): Promise<{ status: number; uri: string }> {
    const candidate = addPath(container, 'res' + Date.now());
    const status = await storage.reserveURI(candidate);
    return { status, uri: candidate };
  }

  // reserves a unique URI for a new resource
  async function assignURI(container: string, slug: string | undefined): Promise<{ status: number; uri: string }> {
    if (slug) {
      const candidate = addPath(container, slug);
      const status = await storage.reserveURI(candidate);
      if (status !== 201) {
        return uniqueURI(container);
      }
      return { status: 201, uri: candidate };
    }
    return uniqueURI(container);
  }

  // look for a Link request header indicating ldp:Resource interaction model
  function hasResourceLink(req: LdpRequest): boolean {
    const link = req.get('Link');
    return !!link &&
      /<http:\/\/www\.w3\.org\/ns\/ldp#Resource\>\s*;\s*rel\s*=\s*(("\s*([^"]+\s+)*type(\s+[^"]+)*\s*")|\s*type[\s,;$])/
      .test(link);
  }

  function hasPreferInclude(req: LdpRequest, inclusion: string): boolean {
    return hasPrefer(req, 'include', inclusion);
  }

  function hasPreferOmit(req: LdpRequest, omission: string): boolean {
    return hasPrefer(req, 'omit', omission);
  }

  function hasPrefer(req: LdpRequest, token: string, parameter: string): boolean {
    if (!req) return false;
    const preferHeader = req.get('Prefer');
    if (!preferHeader) return false;
    const word = parameter.replace(/\./g, '\\.');
    const regex = new RegExp(token + '\\s*=\\s*("\\s*([^"]+\\s+)*' + word + '(\\s+[^"]+)*\\s*"|' + word + '$)');
    return regex.test(preferHeader);
  }

  // check the consistency of the membership triple pattern for a direct container
  function isMembershipPatternValid(document: LdpDocument): boolean {
    if (document.interactionModel !== ldp.DirectContainer) {
      return true;
    }
    if (!document.membershipResource) {
      return false;
    }
    if (document.hasMemberRelation) {
      return !document.isMemberOfRelation;
    }
    if (document.isMemberOfRelation) {
      return !document.hasMemberRelation;
    }
    return false;
  }

  // --- Route handlers ---

  // Internal function to handle LDP GET and HEAD requests
  async function get(req: LdpRequest, res: Response, includeBody: boolean): Promise<void> {
    res.set('Vary', 'Accept');
    const { status, document } = await storage.read(req.fullURL);
    if (status !== 200 || !document) {
      res.sendStatus(status);
      return;
    }

    addHeaders(req, res, document);

    // determine what format to serialize using the Accept header
    let serialize: string;
    if (req.accepts(media.turtle)) {
      serialize = media.turtle;
    } else if (req.accepts(media.jsonld) || req.accepts(media.json)) {
      serialize = media.jsonld;
    } else if (req.accepts(media.rdfxml)) {
      serialize = media.rdfxml;
    } else {
      res.sendStatus(406);
      return;
    }

    const { status: calcStatus, preferenceApplied } = await insertCalculatedTriples(req, document);
    if (calcStatus !== 200) {
      console.error(`Error inserting calculated triples: ${calcStatus}`);
      res.sendStatus(500);
      return;
    }

    const content = await serializeRdf(document.sym(req.fullURL), document, 'none:', serialize);

    if (preferenceApplied) {
      res.set('Preference-Applied', 'return=representation');
    }

    const eTag = getETag(content);
    if (req.get('If-None-Match') === eTag) {
      res.sendStatus(304);
      return;
    }

    res.status(200).set({
      'ETag': eTag,
      'Content-Type': serialize,
    });
    if (includeBody) {
      res.send(Buffer.from(content));
    } else {
      res.end();
    }
  }

  async function putUpdate(req: LdpRequest, res: Response, document: LdpDocument, newTriples: LdpDocument, serialize: string): Promise<void> {
    // LDP servers should not support update of LDPCs
    if (document.interactionModel === ldp.BasicContainer || document.interactionModel === ldp.DirectContainer) {
      res.set('Allow', 'GET,HEAD,DELETE,OPTIONS,POST').sendStatus(405);
      return;
    }

    const ifMatch = req.get('If-Match');
    if (!ifMatch) {
      res.sendStatus(428);
      return;
    }

    if (req.is(media.turtle)) {
      serialize = media.turtle;
    } else {
      serialize = media.jsonld;
    }

    const content = await serializeRdf(document.sym(document.uri), document, 'none:', serialize);
    const eTag = getETag(content);
    if (ifMatch !== eTag) {
      res.sendStatus(412);
      return;
    }

    updateInteractionModel(newTriples);
    const status = await storage.update(newTriples);
    res.sendStatus(status);
  }

  async function putCreate(req: LdpRequest, res: Response, document: LdpDocument): Promise<void> {
    document.uri = req.fullURL;
    updateInteractionModel(document);

    if (hasResourceLink(req)) {
      document.interactionModel = ldp.RDFSource;
    }

    if (!isMembershipPatternValid(document)) {
      res.sendStatus(409);
      return;
    }

    const status = await storage.update(document);
    res.sendStatus(status);
  }

  // --- Build Express sub-app ---

  const subApp = express();
  subApp.use(fullURL as express.RequestHandler);
  subApp.use(rawBody as express.RequestHandler);
  const resource = subApp.route((env.context ?? '/r/') + '{*splat}');

  // CORS and LDP Link headers for all responses
  resource.all((req: Request, res: Response, next: NextFunction) => {
    // CORS headers for browser-based clients (must echo origin, not wildcard, when credentials are used)
    const origin = req.get('Origin');
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, OSLC-Core-Version, If-Match, If-None-Match, Slug');
    res.set('Access-Control-Expose-Headers', 'ETag, Link, Location, Content-Type, Accept-Post, Allow');

    // Handle CORS preflight
    if (req.method === 'OPTIONS' && req.get('Access-Control-Request-Method')) {
      res.sendStatus(204);
      return;
    }

    const links: Record<string, string> = {
      type: ldp.Resource,
    };
    links[ldp.constrainedBy] = appBase + '/constraints.html';
    res.links(links);
    next();
  });

  resource.get(asyncHandler(async (req, res) => {
    await get(req, res, true);
  }));

  resource.head(asyncHandler(async (req, res) => {
    await get(req, res, false);
  }));

  resource.put(asyncHandler(async (req, res) => {
    let serialize: string;
    if (req.is(media.turtle)) {
      serialize = media.turtle;
    } else if (req.is(media.jsonld) || req.is(media.json)) {
      serialize = media.jsonld;
    } else {
      res.sendStatus(415);
      return;
    }

    const newTriples = new rdflib.IndexedFormula() as unknown as LdpDocument;
    await parseRdf(req.rawBody, newTriples, req.fullURL, serialize);
    newTriples.uri = req.fullURL;

    const { status, document } = await storage.read(req.fullURL);
    if (status === 200 && document) {
      await putUpdate(req, res, document, newTriples, serialize);
    } else if (status === 404) {
      await putCreate(req, res, newTriples);
    } else {
      res.sendStatus(status);
    }
  }));

  resource.post(asyncHandler(async (req, res) => {
    const { status: readStatus, document: container } = await storage.read(req.fullURL);
    if (readStatus !== 200 && readStatus !== 404) {
      console.log(`cannot POST to ${req.fullURL}, got: ${readStatus}`);
      res.sendStatus(readStatus);
      return;
    }

    // Determine if the target is a container (has an interactionModel).
    // When readStatus is 404, the target is a creation factory URL with no
    // stored container document -- POST still proceeds but we skip
    // membership/containment triple insertion.
    const isContainer = !!container?.interactionModel;

    let serialize: string;
    if (req.is(media.turtle)) {
      serialize = media.turtle;
    } else if (req.is(media.jsonld) || req.is(media.json)) {
      serialize = media.jsonld;
    } else {
      res.sendStatus(415);
      return;
    }

    const { status: assignStatus, uri: loc } = await assignURI(req.fullURL, req.get('Slug'));
    if (assignStatus !== 201) {
      console.log(assignStatus);
      res.sendStatus(500);
      return;
    }

    const newMember = new rdflib.IndexedFormula() as unknown as LdpDocument;
    newMember.uri = loc;

    try {
      await parseRdf(req.rawBody, newMember, loc, serialize);
    } catch (parseErr) {
      console.log(`error parsing POST body for ${loc}, error: ${parseErr}`);
      await storage.releaseURI(loc);
      res.sendStatus(400);
      return;
    }

    updateInteractionModel(newMember);
    addHeaders(req, res, newMember);

    if (hasResourceLink(req)) {
      newMember.interactionModel = ldp.RDFSource;
    }

    if (!isMembershipPatternValid(newMember)) {
      await storage.releaseURI(loc);
      res.sendStatus(409);
      return;
    }

    // Add the membership triple required to realize the containment.
    // Skip when the target is a creation factory (no container document).
    if (isContainer) {
      if (container!.interactionModel === ldp.DirectContainer) {
        if (container!.isMemberOfRelation) {
          newMember.add(rdflib.sym(loc), rdflib.sym(container!.isMemberOfRelation), rdflib.sym(container!.membershipResource!));
        } else {
          const data = new rdflib.IndexedFormula();
          data.add(rdflib.sym(container!.membershipResource!), rdflib.sym(container!.hasMemberRelation!), rdflib.sym(loc));
          await storage.insertData(data, container!.membershipResource!);
        }
      } else {
        const data = new rdflib.IndexedFormula();
        data.add(rdflib.sym(req.fullURL), LDP('contains'), rdflib.sym(loc));
        await storage.insertData(data, req.fullURL);
      }
    }

    const updateStatus = await storage.update(newMember);
    if (updateStatus !== 201) {
      console.log('Cannot create resource: ' + updateStatus);
      await storage.releaseURI(loc);
      res.sendStatus(500);
      return;
    }
    res.location(loc).sendStatus(201);
  }));

  resource.delete(asyncHandler(async (req, res) => {
    const resourceURI = req.fullURL;

    // Clean up container membership before deleting the resource.
    // Derive the parent container URI by stripping the last path segment.
    const containerURI = resourceURI.replace(/\/[^/]+\/?$/, '');
    if (containerURI && containerURI !== resourceURI) {
      const { status: containerStatus, document: container } = await storage.read(containerURI);
      if (containerStatus === 200 && container) {
        if (container.interactionModel === ldp.DirectContainer && container.hasMemberRelation && container.membershipResource) {
          // Remove: <membershipResource> <hasMemberRelation> <resource>
          const data = new rdflib.IndexedFormula();
          data.add(rdflib.sym(container.membershipResource), rdflib.sym(container.hasMemberRelation), rdflib.sym(resourceURI));
          await storage.removeData(data, container.membershipResource);
        } else if (container.interactionModel === ldp.BasicContainer) {
          // Remove: <container> ldp:contains <resource>
          const data = new rdflib.IndexedFormula();
          data.add(rdflib.sym(containerURI), LDP('contains'), rdflib.sym(resourceURI));
          await storage.removeData(data, containerURI);
        }
      }
    }

    const status = await storage.remove(resourceURI);
    res.sendStatus(status);
  }));

  resource.options(asyncHandler(async (req, res) => {
    const { status, document } = await storage.read(req.fullURL);
    if (status !== 200 || !document) {
      console.log('Cannot get options on resource: ' + status);
      res.sendStatus(status);
      return;
    }
    addHeaders(req, res, document);
    res.sendStatus(200);
  }));

  return subApp;
}
