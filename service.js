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
 * service.js is Express middleware that handles HTTP requests for LDP resources.
 * It is built on an abstract storage implementation, storage.js that can be
 * implemented on different data sources to expose them as LDP resources.
 * The internal, in-memory representation of a resource is an rdflib.js
 * IndexedFormula.
 */

var express = require('express')
var rdflib = require('rdflib')
var ldp = require('./vocab/ldp.js'); // LDP vocabulary
var rdf = require('./vocab/rdf.js'); // RDF vocabulary
var media = require('./media.js'); // media types
var crypto = require('crypto'); // for MD5 (ETags)

// Some convenient namespaces
var RDF = rdflib.Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")
var RDFS = rdflib.Namespace("http://www.w3.org/2000/01/rdf-schema#")
var LDP = rdflib.Namespace('http://www.w3.org/ns/ldp#')

var appBase = undefined;
var db = undefined;


/*
 * Middleware to create the full URI for the request for use in 
 * storage identifiers.
 */
fullURL = function(req, res, next) {
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


/*
 * Middleware to handle all LDP requests
 */
var ldpRoutes = function(env) {

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
			if (err !== 200) {
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
				if (err !== 200) {
					console.error(`Error inserting calculated triples: ${err}`);
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
		// LDP servers should not support update of LDPCs
		if (document.interactionModel === ldp.BasicContainer || document.interactionModel === ldp.DirectContainer) {
			res.set('Allow', 'GET,HEAD,DELETE,OPTIONS,POST').sendStatus(405);
			return;
		}

		var ifMatch = req.get('If-Match');
		if (!ifMatch) {
			res.sendStatus(428);
			return;
		}

		if (req.is(media.turtle)) {
			serialize = media.turtle;
		} else {
			serialize = media.jsonld;
		}

		// serialize the read document in order to calculate the ETag from the matching representation
	    rdflib.serialize(document.sym(document.uri), document, "none:", serialize, function(err, content) {
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

			// determine if there are changes to the interaction model
			updateInteractionModel(newTriples);

			db.update(newTriples, function(err) {
				res.sendStatus(err);
			});
		});
	}

	function putCreate(req, res, document) {
		document.uri = req.fullURL
		updateInteractionModel(document)

		// check if the client requested a specific interaction model through a
		// Link header.  if so, override what we found from the RDF content.
		// FIXME: look for Link type=container as well
		if (hasResourceLink(req)) {
			document.interactionModel = ldp.RDFSource
		}

		// check the membership triple pattern if this is a direct container
		if (!isMembershipPatternValid(document)) {
			res.sendStatus(409)
			return
		}

		db.update(document, function(err) {
			res.sendStatus(err)
		});
	}

	/*
	 * Imiplements the HTTP PUT method which requests that the enclosed entity be 
	 * stored under the supplied Request-URI. Uses putUpdate to update an existing
	 * resource and putCreate to create a new one.
	 */
	resource.put(function(req, res, next) {
		var serialize
		if (req.is(media.turtle)) {
			serialize = media.turtle
		} else if (req.is(media.jsonld) || req.is(media.json)) {
			serialize = media.jsonld
		} else {
			res.sendStatus(415)
			return;
		}
		var newTriples = new rdflib.IndexedFormula()
		rdflib.parse(req.rawBody, newTriples, req.fullURL, serialize, function(err, newTriples) {
			if (err) {
				console.log(err.stack)
				res.sendStatus(500)
				return
			}
			newTriples.uri = req.fullURL

			// get the resource to check if it exists and check its ETag
			db.read(req.fullURL, function(err, document) {
				if (err === 200) {
					// the resource exists. update it
					putUpdate(req, res, document, newTriples, serialize)
				} else if (err === 404) {
					// the resource doesn't exist, create it
					putCreate(req, res, newTriples)
				} else {
					// there was some error, send it along
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
		db.read(req.fullURL, function(err, container) {
			if (err !== 200) {
				console.log(`cannot POST to LDPC ${req.fullURL}, got: ${err}`);
				res.sendStatus(err);
				return;
			}

			// ldp-service POST must be to a container
			if (!container.interactionModel) {
				res.set('Allow', 'GET,HEAD,PUT,DELETE,OPTIONS').sendStatus(405)
				return
			}

			// determine how to serialize the entity request body, the resource being added to the LDPC
			var serialize
			if (req.is(media.turtle)) {
				serialize = media.turtle
			} else if (req.is(media.jsonld) || req.is(media.json)) {
				serialize = media.jsonld
			} else {
				res.sendStatus(415)
				return;
			}

			assignURI(req.fullURL, req.get('Slug'), function(err, loc) {
				if (err !== 201) {
					console.log(err)
					res.sendStatus(500)
					return
				}

				// Parse the entity response body, the resource to add to the container
				var newMember = new rdflib.IndexedFormula();
				newMember.uri = loc; 
				rdflib.parse(req.rawBody, newMember, loc, serialize, function(err, document) {
					// document and newMember are the same thing from here on...
					if (err) {
						// allow the URI to be used again if this is a bad request
						console.log(`error parsing POST body for ${loc}, error: ${err}`);
						db.releaseURI(loc)
						res.sendStatus(400)
						return
					}
					updateInteractionModel(newMember); // newMember is RDFResource, DirectContainer or BasicContainer
					addHeaders(req, res, newMember)

					// check if the client requested a specific interaction model through a Link header
					// if so, override what we found from the RDF content
					// TODO: look for Link type=container as well
					if (hasResourceLink(req)) {
						newMember.interactionModel = ldp.RDFSource
					}

					// check the membership triple pattern if the new member is a direct container
					if (!isMembershipPatternValid(newMember)) {
						db.releaseURI(loc)
						res.sendStatus(409)
						return
					}

					// Add the membership triple required to realize the containment
					if (container.interactionModel === ldp.DirectContainer) {
						if (container.isMemberOfRelation) {
							newMember.add(rdflib.sym(loc), rdflib.sym(container.isMemberOfRelation), rdflib.sym(container.membershipResource));
						} else {
							// container uses hasMemberRelation
							let data = new rdflib.IndexedFormula();
							data.add(rdflib.sym(container.membershipResource), rdflib.sym(container.hasMemberRelation), rdflib.sym(loc));
							db.insertData(data, container.membershipResource, status => {});
						}
					} else {
							// update the BasicContainer's member
							let data = new rdflib.IndexedFormula();
							data.add(rdflib.sym(req.fullURL), LDP('contains'), rdflib.sym(loc));
							db.insertData(data, req.fullURL, status => {});
					}
					// update the membership resource
					db.update(newMember, function(err) {
						if (err !== 201) {
							console.log("Cannot create resource: "+err)
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

	resource.delete(function(req, res, next) {
		db.remove(req.fullURL, function(status) {
			res.sendStatus(status)
		})
	})

	resource.options(function(req, res, next) {
		db.read(req.fullURL, function(err, document) {
			if (err !== 200) {
				console.log("Cannot get options on resource: "+err)
				res.sendStatus(err)
				return
			}
			addHeaders(req, res, document)
			res.sendStatus(200)
		})
	})


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

        var uriSym = document.sym(document.uri)
        if (document.statementsMatching(uriSym, RDF('type'), LDP('BasicContainer')).length !==0) interactionModel = ldp.BasicContainer
        if (document.statementsMatching(uriSym, RDF('type'), LDP('DirectContainer')).length !==0) interactionModel = ldp.DirectContainer
        if (interactionModel === ldp.DirectContainer) {
            var statement = document.any(uriSym, LDP("membershipResource"))
            if (statement) document.membershipResource = statement.value
            statement = document.any(uriSym, LDP("hasMemberRelation"))
            if (statement) document.hasMemberRelation = statement.value
            statement = document.any(uriSym, LDP("isMemberOfRelation"))
            if (statement) document.isMemberOfRelation = statement.value
        }

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
				callback(200, true); // preference applied
				return;
			}

			// respond with Preference-Applied: return=representation if
			// membership was explicitly requested
			var preferenceApplied = hasPreferInclude(req, ldp.PreferMembership);
			var inserted = 0;
			patterns.forEach(function(pattern) {
				db.getMembershipTriples(pattern.container, function(err, containment) {
					if (err !== 200) {
						console.log(`Error inserting membership triples: ${err}`)
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
						callback(200, preferenceApplied);
					}
				});
			});
		} else {
			callback(200, false);
		}
	}

	// insert any dynamically calculated triples
	function insertCalculatedTriples(req, document, callback) {
		// insert membership if this is a membership resource
		insertMembership(req, document, function(err, preferenceApplied) {
			if (err !== 200) {
				callback(err);
				return;
			}
			// all done if this is not a container
			if (document.interactionModel === null) {
				callback(200, preferenceApplied);
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
				callback(200, preferenceApplied);
				return;
			}
			db.getMembershipTriples(document, function(err, members) {
				if (err !== 200) {
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

				callback(200, preferenceApplied);
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

	// reserves a unique URI for a new resource. will use slug if available,
	// but falls back to the usual naming scheme if slug is already used
	function assignURI(container, slug, callback) {
		if (slug) {
			var candidate = addPath(container, slug)
			db.reserveURI(candidate, function(status) {
				if (status !== 201) {
					uniqueURI(container, callback)
				} else {
					callback(201, candidate)
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
	db = env.storageService;
	db.init(env, function(err) {
		if (err) {
			console.error(err)
			console.error("Can't initialize the database.")
			return
		}
	});
	return ldpRoutes(env)
}
