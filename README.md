# openapi-request-validator-generator

> Generate code to validate request properties against an OpenAPI spec.

## Example

```javascript
// Part 1. Here's how you generate the code (use this in a build script)

const generateOASValidationCode = require('openapi-request-validator-generator')

// Note that the ./generatedCode directory will be deleted if anything exists there currently
generateOASValidationCode('./path/to/oas.yaml', './generatedCode')


// Part 2. Here's how you use the generated code at runtime

// resource & method will be a specific resource and method from your OAS. The "oas" part comes from the filename of your OAS. If the spec file is named "yipee.yaml", and contains a resource GET /monkeys, then your generated filename would be "yipee_monkeys_get.js"

// each endpoint in your OAS will have a unique validator that you will need to import, as it's validation is specific to that endpoint

const validateRequest = require('./generatedCode/oas_resource_method.js') 

const request = {
  headers: {
    'content-type': 'application/json'
  },
  body: {},
  params: {},
  query: {foo: 'wow'}
};
const errors = validateRequest(request);
console.log(errors); // => undefined
```
