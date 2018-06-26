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
 * Initializes the ldp-server and opens a client view for 
 * accessing LDP resouces and displaying a graph of their links
 */

var express = require('express')
var ldpService = require('../../ldp-service')

// define a simple environment for testing
var env = {
	"scheme": "http",
	"host": "localhost",
	"port": 3000,
	"context": "/r",
	"storageImpl": "ldp-service-jena",
	"jenaURL": "http://localhost:3030/mrm/",
}

// setup LDP middleware
var app = express()
app.use(express.static(__dirname + '/public'))

// initialize database and set up LDP services and viz when ready
app.use(ldpService(env))

// error handling (developer centric)
app.use(function(err, req, res, next){
	console.error(err.stack)
	res.send(500, 'Something broke!')
})

// Start server
app.listen(env.port, env.host)
console.log('App started on port ' + env.port)
