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
 * any other data source in order to provide LDP access to those resources.
 *
 * The abstraction of data storage services is of a container of resources that 
 * represent RDF graphs.
 * 
 */

/*
 * Initialize the database. This could be done using
 * the facilities of the DBMS and may not need to be implemented
 * in all cases. It does provide a way to specify the env.dbName
 * for the database you want to use, and makes sure the database
 * exists and is initialized, possibly with at least one root
 * container graph.
 *
 * @param {config} env - provides the environment parameters
 * @param {callback} callback()
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
 * 
 * @param {callback} callback()
 */
exports.drop = function drop(callback) {
	console.log("storage method drop(callback) not implemented")
}

/*
 * Used in create methods to reserve a URI for subsequent update. 
 * Simply creates an empty graph.
 *
 * @param {URI} uri - The URI to reserve
 * @param {callback} callback(status)
 */
exports.reserveURI = function reserveURI(uri, callback) {
	throw "storage method reserveURI(uri, callback) not implemented"
}

/*
 * Releases a reserved URI that is no longer needed (i.e., the update
 * will never be done)
 *
 * @param {URI} uri - The URI to reserve
 * @param {callback} callback(status)
 */
exports.releaseURI = function releaseURI(uri) {
	throw "storage method releaseURI(uri) not implemented"
}

/*
 * read a resource given its URI.
 *
 * @param {URI} uri - The URI to read/GET
 * @param {callback} callback(status, IndexedFormula)
 */
exports.read = function read(uri, callback) {
	throw "storage method read(uri, callback) not implemented"
}

/*
 * Update a resource (an IndexedFormula).
 *
 * @param {IndexedFormula} resource - The resource content to update (includes its uri)
 * @param {callback} callback(status)
 */
exports.update = function update(resource, callback) {
	throw "storage method uptate(resource, callback) not implemented"
}

/*
 * Insert data (an IndexedFormula) into an existing resource.
 * Could be useful to implement HTTP PATCH.
 *
 * @param {IndexedFormula} data - the triples to insert
 * @param {URI} uri - URI of the resource to insert the triples into
 * @param {callback} callback(status)
 */
exports.insertData = function insertData(data, uri, callback) {
	throw "storage method insertData(data, intoURI, callback) not implemented"
}

/*
 * Remove or delete a resource given its URI.
 *
 * @param {URI} uri - The URI of the resource to remove/delete
 * @param {callback} callback(status)
 */
exports.remove = function remove(uri, callback) {
	throw "storage method remove(uri, callback) not implemented"
}

/*
 * Get the membershipTriples of a DirectContainer a resource given its URI.
 * These are calculated based on its membershipResource and the hasMembershipRelation
 * or isMemberOfRelation properties of the DirectContainer.
 *
 * @param {URI} container - the URI of the container to whose members are being accessed
 * @param {callback} callback(status, [URI])
 */
exports.getMembershipTriples = function getMembershipTriples(container, callback) {
	throw "storage method getMembershipTriples(container, callback) not implemented"
}



