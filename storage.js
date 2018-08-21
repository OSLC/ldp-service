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
 * Initialize the database. This could be done using
 * the facilities of the DBMS and may not need to be implemented
 * in all cases. It does provide a way to specify the env.dbName
 * for the database you want to use, and makes sure the database
 * exists and is initialized, possibly with at least one root
 * container graph.
 */
exports.init = function init(env, callback) {
	console.log("storage method init(env, callback) not implemented")
}

/*
 * Drop an initialized database. This could be done using
 * the facilities of the DBMS and may not need to be implemented
 * in all cases. Implement this if you want init/drop to be able
 * to dynamically create and remove databases. Don't implement
 * it if you want the database to be already implemented outside
 * the app.
 */
exports.drop = function drop(callback) {
	console.log("storage method drop(callback) not implemented")
}

/*
 * Used in create methods to reserve a URI for subsequent update. 
 * Simply creates an empty graph.
 */
exports.reserveURI = function reserveURI(uri, callback) {
	throw "storage method reserveURI(uri, callback) not implemented"
}

/*
 * Releases a reserved URI that is no longer needed (i.e., the update
 * will never be done)
 */
exports.releaseURI = function releaseURI(uri) {
	throw "storage method releaseURI(uri) not implemented"
}


exports.update = function update(resource, callback) {
	throw "storage method uptate(resource, callback) not implemented"
}

exports.read = function read(uri, callback) {
	throw "storage method read(uri, callback) not implemented"
}

exports.remove = function remove(uri, callback) {
	throw "storage method remove(uri, callback) not implemented"
}

exports.findContainer = function findContainer(uri, callback) {
	throw "storage method findContainer(uri, callback) not implemented"
}

exports.getMembershipTriples = function getMembershipTriples(container, callback) {
	throw "storage method getContainment(uri, callback) not implemented"
}

exports.createMembershipResource = function createMembershipResource(resource, callback) {
	throw "storage method createMembershipResource(resource, callback) not implemented"
}


