# ldp-service

A simple Node.js module providing Express middleware to create a [W3C Linked Data Platform](http://www.w3.org/2012/ldp) server. The service uses MongoDB for persistence, jsonld.js for JSON-LD support, and a few other JavaScript libraries.  A sample app using the LDP middleware service is running at [http://ldp-app.mybluemix.net](http://ldp-app.mybluemix.net).

ldp-service supports LDP basic and direct containers. Indirect
containers and non-RDF source are not implemented.

Many thanks to Steve Speicher and Sam Padgett for their valuable contribution to LDP and this LDP middleware.


## Using

1) Install the required modules

Install [Node.js](http://nodejs.org). 

Install and start [MongoDB](http://docs.mongodb.org/manual/installation/).

Install express.js and create a sample express app

	$ npm install express -g
	$ express --git -e <appDir>

2) Edit the package.json file to add a dependency on ldp-service

	"dependencies": {"ldp-service": "~0.0.1"},

3) Edit app.js and add whatever Express middleware you need including ldp-service. ldp-service also provides access to its MongoDB database in case additional middleware needs direct access to the database.

	var ldpService = require('ldp-service');
	app.use(ldpService());
	var db = ldpService.db; // incase further middleware needs access to the database

4) Configuration defaults can be found in config.json. These may be overridden by variables in the environment, including Bluemix variables if deployed in a Bluemix app.

5) To start the app, run these commands

    $ npm install
    $ node app.js

Finally, point your browser to
[http://localhost:3000/](http://localhost:3000/).

## License

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
