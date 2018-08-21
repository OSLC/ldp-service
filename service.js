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
 * server.js is Express middleware that handles HTTP requests for LDP resources.
 * It is built on an abstract storage implementation, storage.js that can be
 * implemented on different data sources to expose them as LDP resources.
 * The internal, in-memory representation of a resource is an rdflib.js
 * IndexedFormula.
 */

var express = require('express')
var appBase = undefined
var rdflib = require('rdflib')
var RDF = rdflib.Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")
var RDFS = rdflib.Namespace("http://www.w3.org/2000/01/rdf-schema#")

// Some convenient namespaces
var LDP = rdflib.Namespace('http://www.w3.org/ns/ldp#')

/*
 * Middleware to create the full URI for the request for use in 
 * storage identifiers.
 */
var fullURL = function(req, res, next) {
	req.fullURL = appBase + req.originalUrl;
	next();
}

/* 
 * Middleware to create a UTF8 encoded copy of the original request body
 * used in JSON and N3 parsers.
 */
var rawBody = function(req, res, next) {
	req.rawBody = '';
	req.setEncoding('utf8');

	req.on('data', function(chunk) {
		req.rawBody += chunk;
	});

	req.on('end', function() {
		next();
	});
}

var rdflib = require('rdflib')
var ldp = require('./vocab/ldp.js'); // LDP vocabulary
var rdf = require('./vocab/rdf.js'); // RDF vocabulary
var media = require('./media.js'); // media types
var crypto = require('crypto'); // for MD5 (ETags)


/*
 * Middleware to handle all LDP requests
 */
var ldpRoutes = function(db, env) {

	var subApp = express();
	subApp.use(fullURL);
	subApp.use(rawBody);
	var resource = subApp.route(env.context + '*');

	// route any requests matching the LDP context (defaults to /r/*)
	resource.all(function(req, res, next) {
		// all responses should have Link: <ldp:Resource> rel=type
		var links = {
			type: ldp.Resource
		}
		// also include implementation constraints
		links[ldp.constrainedBy] = env.appBase + '/constraints.html'
		res.links(links)
		next()
	})

	// Internal function to handle LDP GET and HEAD requests
	function get(req, res, includeBody) {
		res.set('Vary', 'Accept')
		// delegate access to the resource to the storage service
		// the document is an rdflib.js IndexedFormula
		db.read(req.fullURL, function(err, document) {
			if (err) {
				res.sendStatus(err)
				return
			}

			// add common response headers
			addHeaders(req, res, document)

			// determine what format to serialize using the Accept header
			var serialize
			if (req.accepts(media.turtle)) {
				serialize = media.turtle
			} else if (req.accepts(media.jsonld) || req.accepts(media.json)) {
				serialize = media.jsonld
			} else if (req.accepts(media.rdfxml)) {
				serialize = media.rdfxml
			} else {
				res.sendStatus(406)
				return;
			}

			// some triples like containment are calculated on-the-fly rather
			// than being stored in the document
			// insertCalculatedTriples also looks at the Prefer header to see
			// what to include, the containment triples, membership predicates, or both
			insertCalculatedTriples(req, document, function(err, preferenceApplied) {
				if (err) {
					console.log(err.stack)
					res.sendStatus(500)
					return
				}

				// Serialize the resource
				// target must be undefined, and base set to an unused prefix to get the proper namespaces and URIs
				rdflib.serialize(document.sym(req.fullURL), document, "none:", serialize, function(err, content) {
					if (err) {
						console.log(err.stack)
						res.sendStatus(500)
						return
					}

					if (preferenceApplied) {
						res.set('Preference-Applied', 'return=representation')
					}

					// generate an ETag for the content
					var eTag = getETag(content);
					if (req.get('If-None-Match') === eTag) {
						res.sendStatus(304)
						return
					}

					res.writeHead(200, {
						'ETag': eTag,
						'Content-Type': serialize
					})
					if (includeBody) {
						res.end(new Buffer.from(content), 'utf-8')
					} else {
						res.end()
					}
				})
			})
		})
	} // get

	resource.get(function(req, res, next) {
		get(req, res, true);
	});

	resource.head(function(req, res, next) {
		get(req, res, false);
	});

	function putUpdate(req, res, document, newTriples, serialize) {
		if (getInteractionMocel(req.fullURL, document)) {
			res.set('Allow', 'GET,HEAD,DELETE,OPTIONS,POST').sendStatus(405);
			return;
		}

		var ifMatch = req.get('If-Match');
		if (!ifMatch) {
			res.sendStatus(428);
			return;
		}

		// add membership triples if necessary to calculate the correct ETag
		insertCalculatedTriples(null, document, function(err) {
			if (err) {
				console.log(err.stack);
				res.sendStatus(500);
				return;
			}

			if (req.is(media.turtle)) {
				serialize = turtle.serialize;
			} else {
				serialize = jsonld.serialize;
			}

			// calculate the ETag from the matching representation
			serialize(document.triples, function(err, contentType, content) {
				if (err) {
					console.log(err.stack);
					res.sendStatus(500);
					return;
				}

				var eTag = getETag(content);
				if (ifMatch !== eTag) {
					res.sendStatus(412);
					return;
				}

				// remove any containment triples from the request body if this
				// is a container.  then update the document with the new
				// triples.  we store containment with the resources
				// themselves, not in the container document.
				document.triples = newTriples;

				// determine if there are changes to the interaction model
				updateInteractionModel(document);

				// remove any membership triples if this is a membership
				// resource so we don't store them directly
				removeMembership(document);

				db.update(document, function(err) {
					if (err) {
						console.log(err);
						res.sendStatus(err);
						return;
					}

					res.sendStatus(204);
				});
			});
		});
	}

	function putCreate(req, res, triples) {
		var document = {
			name: req.fullURL,
			triples: triples
		};
		updateInteractionModel(document);

		// check if the client requested a specific interaction model through a
		// Link header.  if so, override what we found from the RDF content.
		// FIXME: look for Link type=container as well
		if (hasResourceLink(req)) {
			document.interactionModel = ldp.RDFSource;
		}

		// check the membership triple pattern if this is a direct container
		if (!isMembershipPatternValid(document)) {
			res.sendStatus(409);
			return;
		}

		db.update(document, function(err) {
			if (err) {
				console.log(err.stack);
				res.sendStatus(500);
				return;
			}

			// create a membership resource if necessary.
			createMembershipResource(document, function(err) {
				if (err) {
					console.log(err.stack);
					db.releaseURI(loc);
					res.sendStatus(500);
					return;
				}

				res.sendStatus(201);
			});
		});
	}

	/*
	 * Imiplements the HTTP PUT method which requests that the enclosed entity be 
	 * stored under the supplied Request-URI. Uses putUpdate to update an existing
	 * resource and putCreate to create a new one.
	 */
	resource.put(function(req, res, next) {
		var parse, serialize
		if (req.is(media.turtle)) {
			parse = turtle.parse
			serialize = turtle.serialize
		} else if (req.is(media.jsonld) || req.is(media.json)) {
			parse = jsonld.parse
			serialize = jsonld.serialize
		} else {
			res.sendStatus(415)
			return;
		}
		var newTriples = new rdflib.IndexedFormula()
		rdfllib.parse(req.rawBody, newTriples, req.fullURL, function(err, newTriples) {
			if (err) {
				res.sendStatus(400)
				return
			}

			// get the resource to check if it exists and check its ETag
			db.read(req.fullURL, function(err, document) {
				if (err === 200) {
					// the resource exists. update it
					putUpdate(req, res, document, newTriples, serialize)
				} else if (err == 404) {
					// the resource doesn't exist, create it
					putCreate(req, res, newTriples)
				} else {
					// there was some error, send it along
					console.log(err)
					res.sendStatus(err)
				}
			})
		})
	})

	/*
	 * Implements HTTP POST to create new resources and add them to
	 * a container.
	 */
	resource.post(function(req, res, next) {
		// find the container for the URL
		db.findContainer(req.fullURL, function(err, container) {
			if (err) {
				console.log(err)
				res.sendStatus(500)
				return
			}

			// ldp-service POST must be to a container
			if (!container) {
				res.set('Allow', 'GET,HEAD,PUT,DELETE,OPTIONS').sendStatus(405)
				return
			}

			var parse
			if (req.is(media.turtle)) {
				parse = turtle.parse
			} else if (req.is(media.jsonld) || req.is(media.json)) {
				parse = jsonld.parse
			} else {
				res.sendStatus(415)
				return
			}

			assignURI(req.fullURL, req.get('Slug'), function(err, loc) {
				if (err) {
					console.log(err)
					res.sendStatus(500)
					return
				}

				var entity = new rdflib.IndexedFormula()
				rdfllib.parse(req.rawBody, entity, loc, function(err, document) {
					if (err) {
						// allow the URI to be used again
						db.releaseURI(loc)
						res.sendStatus(400)
						return
					}

					// TODO: Add the parent container to the parsed entity

					updateInteractionModel(document)
					addHeaders(req, res, document)

					// check if the client requested a specific interaction model through a Link header
					// if so, override what we found from the RDF content
					// FIXME: look for Link type=container as well
					if (hasResourceLink(req)) {
						document.interactionModel = ldp.RDFSource
					}

					// check the membership triple pattern if this is a direct container
					if (!isMembershipPatternValid(document)) {
						db.releaseURI(loc)
						res.sendStatus(409)
						return
					}

					// TODO: add the "inverse" isMemberOfRelation link if needed
					if (container.interactionModel === ldp.DirectContainer &&
							container.isMemberOfRelation) {
						document.add(rdflib.sym(loc), rdflib.sym(container.isMemberOfRelation), rdflib.sym(req.fullURL))
					}

					// create the resource
					db.update(document, function(err) {
						if (err) {
							console.log("Cannot create resource: "+err)
							db.releaseURI(loc)
							res.sendStatus(500)
							return
						}

						// create a membership resource if necessary.
						createMembershipResource(document, function(err) {
							if (err) {
								console.log("Cannot create membership resource: "+err);
								db.releaseURI(loc)
								res.sendStatus(500)
								return
							}

							res.location(loc).sendStatus(201)
						})
					})
				})
			})
		})
	})

	resource.delete(function(req, res, next) {
		db.remove(req.fullURL, function(err, result) {
			if (err) {
				console.log(err.stack)
				res.sendStatus(500)
				return
			}

			res.sendStatus(result ? 204 : 404)
		})
	})

	resource.options(function(req, res, next) {
		db.read(req.fullURL, function(err, document) {
			if (err) {
				console.log("Cannot get options on resource: "+err)
				res.sendStatus(err)
				return
			}
			addHeaders(req, res, document)
			res.sendStatus(200)
		})
	})


	// create a membership resource for the container if it's a direct
	// container and the membership resource is not the container itself
	function createMembershipResource(document, callback) {
		if (document.interactionModel === ldp.DirectContainer &&
			document.membershipResource &&
			document.membershipResource !== document.name) {
			// create membership resource
			db.createMembershipResource(document, callback);
		} else {
			callback();
		}
	}

	// generate an ETag for a response using an MD5 hash
	// note: insert any calculated triples before calling getETag()
	function getETag(content) {
		return 'W/"' + crypto.createHash('md5').update(content).digest('hex') + '"';
	}

	// add common headers to all responses
	function addHeaders(req, res, document) {
		var allow = 'GET,HEAD,DELETE,OPTIONS'
		if (document.interactionModel) {
			res.links({
				type: document.interactionModel
			});
			allow += ',POST';
			res.set('Accept-Post', media.turtle + ',' + media.jsonld + ',' + media.json + ',' + media.rdfxml);
		} else {
			allow += ',PUT';
		}

		res.set('Allow', allow);
	}

	// look at the triples to determine the type of container if this is a
	// container and, if a direct container, its membership pattern
	function updateInteractionModel(document) {
		var interactionModel = ldp.RDFSource;
		document.triples.forEach(function(triple) {
			var s = triple.subject,
				p = triple.predicate,
				o = triple.object;
			if (s !== document.name) {
				return;
			}

			// determine the interaction model from the RDF type
			// direct takes precedence if the resource has both direct and basic RDF types
			if (p === rdf.type && interactionModel !== ldp.DirectContainer && (o === ldp.BasicContainer || o === ldp.DirectContainer)) {
				interactionModel = o;
				return;
			}

			if (p === ldp.membershipResource) {
				document.membershipResource = o;
				return;
			}

			if (p === ldp.hasMemberRelation) {
				document.hasMemberRelation = o;
			}

			if (p === ldp.isMemberOfRelation) {
				document.isMemberOfRelation = o;
			}
		});

		// don't override an existing interaction model
		if (!document.interactionModel) {
			document.interactionModel = interactionModel;
		}
	}

	// determine if this is a membership subApp.  if it is, insert the
	// membership triples.
	function insertMembership(req, document, callback) {
		var patterns = document.membershipResourceFor;
		if (patterns) {
			if (hasPreferOmit(req, ldp.PreferMembership)) {
				callback(null, true); // preference applied
				return;
			}

			// respond with Preference-Applied: return=representation if
			// membership was explicitly requested
			var preferenceApplied = hasPreferInclude(req, ldp.PreferMembership);
			var inserted = 0;
			patterns.forEach(function(pattern) {
				db.getMembershipTriples(pattern.container, function(err, containment) {
					if (err) {
						callback(err);
						return;
					}

					if (containment) {
						containment.forEach(function(resource) {
							document.triples.push({
								subject: document.name,
								predicate: pattern.hasMemberRelation,
								object: resource
							});
						});
					}

					if (++inserted === patterns.length) {
						callback(null, preferenceApplied);
					}
				});
			});
		} else {
			callback(null, false);
		}
	}

	// insert any dynamically calculated triples
	function insertCalculatedTriples(req, document, callback) {
		// insert membership if this is a membership resource
		insertMembership(req, document, function(err, preferenceApplied) {
			if (err) {
				callback(err);
				return;
			}

			// all done if this is not a container
			if (document.interactionModel === null) {
				callback(null, preferenceApplied);
				return;
			}

			// next insert any dynamic triples if this is a container

			// check if client is asking for a minimal container
			var minimal = false;
			if (hasPreferInclude(req, ldp.PreferMinimalContainer) ||
					hasPreferInclude(req, ldp.PreferEmptyContainer)) {
				preferenceApplied = true;
				minimal = true;
			}

			// include containment?
			var includeContainment;
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
			var includeMembership;
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
				// we're done!
				callback(null, preferenceApplied);
				return;
			}

			db.getMembershipTriples(document, function(err, members) {
				if (err) {
					callback(err);
					return;
				}

				if (members) {
					members.forEach(function(member) {
						if (includeContainment) {
							document.add(document.sym(document.uri), LDP('contains'), document.sym(member.member.value), document.sym(document.uri))
						}

						if (includeMembership) {
							document.add(document.sym(document.membershipResource), document.sym(document.hasMemberRelation), document.sym(member.member.value), document.sym(document.uri))
						}
					});
				}

				callback(null, preferenceApplied);
			});
		});
	}

	// append 'path' to the end of a uri
	// - any query or hash in the uri is removed
	// - any special characters like / and ? in 'path' are replaced
	function addPath(uri, path) {
		uri = uri.split("?")[0].split("#")[0];
		if (uri.substr(-1) !== '/') {
			uri += '/';
		}

		// remove special characters from the string (e.g., '/', '..', '?')
		var lastSegment = path.replace(/[^\w\s\-_]/gi, '');
		return uri + encodeURIComponent(lastSegment)
	}

	// generates and reserves a unique URI with base URI 'container'
	function uniqueURI(container, callback) {
		var candidate = addPath(container, 'res' + Date.now())
		db.reserveURI(candidate, function(err) {
			callback(err, candidate)
		});
	}

	// reserves a unique URI for a new subApp. will use slug if available,
	// but falls back to the usual naming scheme if slug is already used
	function assignURI(container, slug, callback) {
		if (slug) {
			var candidate = addPath(container, slug)
			db.reserveURI(candidate, function(err) {
				if (err) {
					uniqueURI(container, callback)
				} else {
					callback(null, candidate)
				}
			});
		} else {
			uniqueURI(container, callback)
		}
	}

	// removes any membership triples from a membership resource before updating
	// it in the database
	// membership triples are not stored with the resource itself but are 
	// calculated based on the Prefer header
	function removeMembership(document) {
		if (document.membershipResourceFor) {
			// find the member relations. handle the case where the resource is
			// a membership resource for more than one container.
			var memberRelations = {}
			document.membershipResourceFor.forEach(function(memberPattern) {
				if (memberPattern.hasMemberRelation) {
					memberRelations[memberPattern.hasMemberRelation] = 1
				}
			});

			// now filter the triples
			document.triples = document.triples.filter(function(triple) {
				// keep the triple if the subject is not the membership
				// resource or the predicate is not one of the member relations
				return triple.subject !== document.name || !memberRelations[triple.predicate]
			})
		}
	}

	// look for a Link request header indicating the entity uses a ldp:Resource
	// interaction model rather than container
	function hasResourceLink(req) {
		var link = req.get('Link')
		// look for links like
		//	 <http://www.w3.org/ns/ldp#Resource>; rel="type"
		// these are also valid
		//	 <http://www.w3.org/ns/ldp#Resource>;rel=type
		//	 <http://www.w3.org/ns/ldp#Resource>; rel="type http://example.net/relation/other"
		return link &&
			/<http:\/\/www\.w3\.org\/ns\/ldp#Resource\>\s*;\s*rel\s*=\s*(("\s*([^"]+\s+)*type(\s+[^"]+)*\s*")|\s*type[\s,;$])/
			.test(link)
	}

	function hasPreferInclude(req, inclusion) {
		return hasPrefer(req, 'include', inclusion)
	}

	function hasPreferOmit(req, omission) {
		return hasPrefer(req, 'omit', omission)
	}

	function hasPrefer(req, token, parameter) {
		if (!req) {
			return false
		}

		var preferHeader = req.get('Prefer')
		if (!preferHeader) {
			return false
		}

		// from the LDP prefer parameters, the only charcter we need to escape
		// for regular expressions is '.'
		// https://dvcs.w3.org/hg/ldpwg/raw-file/default/ldp.html#prefer-parameters
		var word = parameter.replace(/\./g, '\\.')

		// construct a regex that matches the preference
		var regex =
		   	new RegExp(token + '\\s*=\\s*("\\s*([^"]+\\s+)*' + word + '(\\s+[^"]+)*\\s*"|' + word + '$)');
		return regex.test(preferHeader)
	}

	// check the consistency of the membership triple pattern if this is a direct container
	function isMembershipPatternValid(document) {
		if (document.interactionModel !== ldp.DirectContainer) {
			// not a direct container, nothing to do
			return true
		}

		// must have a membership resouce
		if (!document.membershipResource) {
			return false
		}

		// must have hasMemberRelation or isMemberOfRelation, but can't have both
		if (document.hasMemberRelation) {
			return !document.isMemberOfRelation
		}
		if (document.isMemberOfRelation) {
			return !document.hasMemberRelation
		}

		// no membership triple pattern
		return false
	}
	return subApp
}


module.exports = function(env) {
	appBase = env.appBase
	var db = require('./storage.js') // the abstract storage services
	require(env.storageImpl)(db)  // instantiate using a specific storage services implementation
	module.exports.db = db // allow the database to be used by other middleware
	db.init(env, function(err) {
		if (err) {
			console.error(err)
			console.error("Can't initialize the database.")
			return
		}
	});
	return ldpRoutes(db, env)
}
