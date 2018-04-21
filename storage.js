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
 * storage.js is an abstract implementation of the storage services required by
 * ldp-service and oslc-service. This module is intended to be implemented on 
 * different data sources such as Apache Jena, the file system, MongoDB, or
 * any other data source in order to provide LDP and OSLC access to those resources.
 *
 * The abstraction of data storage services is of a container of resources that 
 * represent RDF graphs.
 * 
 */

var ldp = require('./vocab/ldp.js') // LDP vocabulary

var db

function graphs() {
	return db.collection('graphs');
}

// index the graph name for fast lookups and uniqueness
function ensureIndex() {
	graphs().ensureIndex({
		name: 1
	}, {
		unique: true
	}, function(err) {
		if (err) {
			// not fatal, but log the error
			console.log(err.stack);
		}
	});
}

/*
 * Initialize the database
 */
exports.init = function init(env, callback) {
	throw "storage method init(env, callback) not implemented"
}

exports.drop = function drop(callback) {
	throw "storage method drop(callback) not implemented"
}

exports.reserveURI = function reserveURI(uri, callback) {
	throw "storage method reserveURI(uri, callback) not implemented"
}

exports.releaseURI = function releaseURI(uri) {
	throw "storage method releaseURI(uri) not implemented"
}

exports.put = function put(resource, callback) {
	throw "storage method put(resource, callback) not implemented"
}

exports.get = function get(uri, callback) {
	throw "storage method get(uri, callback) not implemented"
}

exports.remove = function remove(uri, callback) {
	throw "storage method remove(uri, callback) not implemented"
}

exports.findContainer = function findContainer(uri, callback) {
	throw "storage method findContainer(uri, callback) not implemented"
}

exports.getContainment = function getContainment(uri, callback) {
	throw "storage method getContainment(uri, callback) not implemented"
}

exports.createMembershipResource = function createMembershipResource(resource, callback) {
	throw "storage method createMembershipResource(resource, callback) not implemented"
}


