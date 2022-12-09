const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const deref = require("json-schema-deref-sync");
const serialize = require("serialize-javascript");
const Ajv = require("ajv");
const standaloneCode = require("ajv/dist/standalone").default;
const addFormats = require("ajv-formats");
const {
  convertParametersToJSONSchema,
} = require("openapi-jsonschema-parameters");
const { dummyLogger } = require("ts-log");
const contentTypeParser = require("content-type");

const LOCAL_DEFINITION_REGEX = /^#\/([^\/]+)\/([^\/]+)$/;

class OpenAPIRequestValidator {
  logger = dummyLogger;
  loggingKey = "";
  requestBodyValidators = {};
  enableHeadersLowercase = true;

  constructor(args, _dir, _fileName) {
    const loggingKey = args && args.loggingKey ? args.loggingKey + ": " : "";
    this.loggingKey = loggingKey;
    if (!args) {
      throw new Error(`${loggingKey}missing args argument`);
    }

    if (args.logger) {
      this.logger = args.logger;
    }

    if (args.hasOwnProperty("enableHeadersLowercase")) {
      this.enableHeadersLowercase = args.enableHeadersLowercase;
    }

    const errorTransformer =
      typeof args.errorTransformer === "function" && args.errorTransformer;
    const errorMapper = errorTransformer
      ? extendedErrorMapper(errorTransformer)
      : toOpenapiValidationError;
    let bodyValidationSchema;
    let bodySchema;
    let headersSchema;
    let formDataSchema;
    let pathSchema;
    let querySchema;
    let isBodyRequired;

    if (args.parameters !== undefined) {
      if (Array.isArray(args.parameters)) {
        const schemas = convertParametersToJSONSchema(args.parameters);
        bodySchema = schemas.body;
        headersSchema = lowercasedHeaders(
          schemas.headers,
          this.enableHeadersLowercase
        );
        formDataSchema = schemas.formData;
        pathSchema = schemas.path;
        if (schemas.query && args.hasOwnProperty("additionalQueryProperties")) {
          schemas.query.additionalProperties = args.additionalQueryProperties;
        }
        querySchema = schemas.query;
        isBodyRequired =
          // @ts-ignore
          args.parameters.filter(byRequiredBodyParameters).length > 0;
      } else {
        throw new Error(`${loggingKey}args.parameters must be an Array`);
      }
    }

    const v = new Ajv({
      useDefaults: true,
      allErrors: true,
      strict: false,
      logger: false,
      ...(args.ajvOptions || {}),
      code: { source: true },
    });
    addFormats(v);

    v.removeKeyword("readOnly");
    v.addKeyword({
      keyword: "readOnly",
      modifying: true,
      compile: (sch) => {
        if (sch) {
          return function validate(data, dataCtx) {
            validate.errors = [
              {
                keyword: "readOnly",
                instancePath: dataCtx.instancePath,
                message: "is read-only",
                params: { readOnly: dataCtx.parentDataProperty },
              },
            ];
            return !(sch === true && data !== null);
          };
        }
        return () => true;
      },
    });

    if (args.requestBody) {
      isBodyRequired = args.requestBody.required || false;
    }

    if (args.customFormats) {
      let hasNonFunctionProperty;
      Object.keys(args.customFormats).forEach((format) => {
        const func = args.customFormats[format];
        if (typeof func === "function") {
          v.addFormat(format, func);
        } else {
          hasNonFunctionProperty = true;
        }
      });
      if (hasNonFunctionProperty) {
        throw new Error(
          `${loggingKey}args.customFormats properties must be functions`
        );
      }
    }

    if (args.customKeywords) {
      for (const [keywordName, keywordDefinition] of Object.entries(
        args.customKeywords
      )) {
        v.addKeyword({
          keyword: keywordName,
          ...keywordDefinition,
        });
      }
    }

    if (bodySchema) {
      bodyValidationSchema = {
        properties: {
          body: bodySchema,
        },
      };
    }
    if (args.componentSchemas) {
      // openapi v3:
      Object.keys(args.componentSchemas).forEach((id) => {
        v.addSchema(args.componentSchemas[id], `#/components/schemas/${id}`);
        this.addSchemaProperties(
          v,
          args.componentSchemas[id],
          `#/components/schemas/${id}`
        );
      });
    } else if (args.schemas) {
      if (Array.isArray(args.schemas)) {
        args.schemas.forEach((schema) => {
          const id = schema.id;

          if (id) {
            const localSchemaPath = LOCAL_DEFINITION_REGEX.exec(id);

            if (localSchemaPath && bodyValidationSchema) {
              let definitions = bodyValidationSchema[localSchemaPath[1]];

              if (!definitions) {
                definitions = bodyValidationSchema[localSchemaPath[1]] = {};
              }

              definitions[localSchemaPath[2]] = schema;
            }

            // backwards compatibility with json-schema-draft-04
            delete schema.id;
            v.addSchema({ $id: id, ...schema }, id);
          } else {
            this.logger.warn(loggingKey, "igorning schema without id property");
          }
        });
      } else if (bodySchema) {
        bodyValidationSchema.definitions = args.schemas;
        bodyValidationSchema.components = {
          schemas: args.schemas,
        };
      }
    }

    if (args.externalSchemas) {
      Object.keys(args.externalSchemas).forEach((id) => {
        v.addSchema(args.externalSchemas[id], id);
      });
    }

    if (args.requestBody) {
      /* tslint:disable-next-line:forin */
      for (const mediaTypeKey in args.requestBody.content) {
        const bodyContentSchema = args.requestBody.content[mediaTypeKey].schema;
        const copied = JSON.parse(JSON.stringify(bodyContentSchema));
        const resolvedSchema = resolveAndSanitizeRequestBodySchema(copied, v);
        const code = standaloneCode(
          v,
          v.compile(
            transformOpenAPIV3Definitions({
              properties: {
                body: resolvedSchema,
              },
              definitions: args.schemas || {},
              components: { schemas: args.schemas },
            })
          )
        );
        const fileKey = `requestBodyValidators_${mediaTypeKey.replace(
          /\//g,
          ""
        )}`;
        const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
        fs.writeFileSync(file, code, "utf-8");
      }
    }

    this.bodySchema = bodySchema;
    this.errorMapper = errorMapper;
    this.isBodyRequired = isBodyRequired;
    this.requestBody = args.requestBody;

    // this.validateBody =
    if (bodyValidationSchema) {
      const code = standaloneCode(
        v,
        v.compile(transformOpenAPIV3Definitions(bodyValidationSchema))
      );
      const fileKey = `validateBody`;
      const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
      fs.writeFileSync(file, code, "utf-8");
    }

    // this.validateFormData =
    if (formDataSchema) {
      const code = standaloneCode(
        v,
        v.compile(transformOpenAPIV3Definitions(formDataSchema))
      );
      const fileKey = `validateFormData`;
      const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
      fs.writeFileSync(file, code, "utf-8");
    }

    // this.validateHeaders =
    if (headersSchema) {
      const code = standaloneCode(
        v,
        v.compile(transformOpenAPIV3Definitions(headersSchema))
      );
      const fileKey = `validateHeaders`;
      const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
      fs.writeFileSync(file, code, "utf-8");
    }

    // this.validatePath =
    if (pathSchema) {
      const code = standaloneCode(
        v,
        v.compile(transformOpenAPIV3Definitions(pathSchema))
      );
      const fileKey = `validatePath`;
      const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
      fs.writeFileSync(file, code, "utf-8");
    }

    //this.validateQuery =
    if (querySchema) {
      const code = standaloneCode(
        v,
        v.compile(transformOpenAPIV3Definitions(querySchema))
      );
      const fileKey = `validateQuery`;
      const file = path.join(_dir, `${_fileName}_${fileKey}.js`);
      fs.writeFileSync(file, code, "utf-8");
    }
  }

  addSchemaProperties(v, schema, prefix) {
    for (const attr in schema) {
      if (schema.hasOwnProperty(attr)) {
        switch (attr) {
          case "allOf":
          case "oneOf":
          case "anyOf":
            for (let i = 0; i < schema[attr].length; i++) {
              this.addSchemaProperties(
                v,
                schema[attr][i],
                `${prefix}/${attr}/${i}`
              );
            }
            return;
          case "items":
            this.addSchemaProperties(v, schema[attr], `${prefix}/${attr}`);
            return;
          case "properties":
            for (const propertyId in schema[attr]) {
              if (schema[attr].hasOwnProperty(propertyId)) {
                const schemaId = `${prefix}/${attr}/${propertyId}`;
                v.addSchema(schema[attr][propertyId], schemaId);
                this.addSchemaProperties(v, schema[attr][propertyId], schemaId);
              }
            }
            return;
        }
      }
    }
  }
}

function validateRequest(request) {
  const errors = [];
  let err;
  let schemaError;
  let mediaTypeError;

  if (_validator.bodySchema) {
    if (request.body) {
      if (!_validator.validateBody({ body: request.body })) {
        errors.push.apply(
          errors,
          withAddedLocation("body", _validator.validateBody.errors)
        );
      }
    } else if (_validator.isBodyRequired) {
      schemaError = {
        location: "body",
        message:
          "request.body was not present in the request.  Is a body-parser being used?",
        schema: _validator.bodySchema,
      };
    }
  }

  if (_validator.requestBody) {
    const contentType = getHeaderValue(request.headers, "content-type");
    const mediaTypeMatch = getSchemaForMediaType(
      contentType,
      _validator.requestBody,
      _validator.logger,
      _validator.loggingKey
    );
    if (!mediaTypeMatch) {
      if (contentType) {
        mediaTypeError = {
          message: `Unsupported Content-Type ${contentType}`,
        };
      } else if (_validator.isBodyRequired) {
        errors.push({
          keyword: "required",
          instancePath: "/body",
          params: {},
          message: "media type is not specified",
          location: "body",
        });
      }
    } else {
      const bodySchema = _validator.requestBody.content[mediaTypeMatch].schema;
      if (request.body) {
        const validateBody = _validator.requestBodyValidators[mediaTypeMatch];
        if (!validateBody({ body: request.body })) {
          errors.push.apply(
            errors,
            withAddedLocation("body", validateBody.errors)
          );
        }
      } else if (_validator.isBodyRequired) {
        schemaError = {
          location: "body",
          message:
            "request.body was not present in the request.  Is a body-parser being used?",
          schema: bodySchema,
        };
      }
    }
  }

  if (_validator.validateFormData && !schemaError) {
    if (!_validator.validateFormData(request.body)) {
      errors.push.apply(
        errors,
        withAddedLocation("formData", _validator.validateFormData.errors)
      );
    }
  }

  if (_validator.validatePath) {
    if (!_validator.validatePath(request.params || {})) {
      errors.push.apply(
        errors,
        withAddedLocation("path", _validator.validatePath.errors)
      );
    }
  }

  if (_validator.validateHeaders) {
    if (
      !_validator.validateHeaders(
        lowercaseRequestHeaders(
          request.headers || {},
          _validator.enableHeadersLowercase
        )
      )
    ) {
      errors.push.apply(
        errors,
        withAddedLocation("headers", _validator.validateHeaders.errors)
      );
    }
  }

  if (_validator.validateQuery) {
    if (!_validator.validateQuery(request.query || {})) {
      errors.push.apply(
        errors,
        withAddedLocation("query", _validator.validateQuery.errors)
      );
    }
  }

  if (errors.length) {
    err = {
      status: 400,
      errors: errors.map(_validator.errorMapper),
    };
  } else if (schemaError) {
    err = {
      status: 400,
      errors: [schemaError],
    };
  } else if (mediaTypeError) {
    err = {
      status: 415,
      errors: [mediaTypeError],
    };
  }

  return err;
}

function byRequiredBodyParameters(param) {
  return (param.in === "body" || param.in === "formData") && param.required;
}

function extendedErrorMapper(mapper) {
  return (ajvError) => mapper(toOpenapiValidationError(ajvError), ajvError);
}

function getSchemaForMediaType(
  contentTypeHeader,
  requestBodySpec,
  logger,
  loggingKey
) {
  if (!contentTypeHeader) {
    return;
  }
  let contentType;
  try {
    contentType = contentTypeParser.parse(contentTypeHeader).type;
  } catch (e) {
    logger.warn(
      loggingKey,
      "failed to parse content-type",
      contentTypeHeader,
      e
    );
    if (e instanceof TypeError && e.message === "invalid media type") {
      return;
    }
    throw e;
  }
  const content = requestBodySpec.content;
  const subTypeWildCardPoints = 2;
  const wildcardMatchPoints = 1;
  let match;
  let matchPoints = 0;
  for (const mediaTypeKey in content) {
    if (content.hasOwnProperty(mediaTypeKey)) {
      if (mediaTypeKey.indexOf(contentType) > -1) {
        return mediaTypeKey;
      } else if (mediaTypeKey === "*/*" && wildcardMatchPoints > matchPoints) {
        match = mediaTypeKey;
        matchPoints = wildcardMatchPoints;
      }
      const contentTypeParts = contentType.split("/");
      const mediaTypeKeyParts = mediaTypeKey.split("/");
      if (mediaTypeKeyParts[1] !== "*") {
        continue;
      } else if (
        contentTypeParts[0] === mediaTypeKeyParts[0] &&
        subTypeWildCardPoints > matchPoints
      ) {
        match = mediaTypeKey;
        matchPoints = subTypeWildCardPoints;
      }
    }
  }
  return match;
}

function lowercaseRequestHeaders(headers, enableHeadersLowercase) {
  if (enableHeadersLowercase) {
    const lowerCasedHeaders = {};

    Object.keys(headers).forEach((header) => {
      lowerCasedHeaders[header.toLowerCase()] = headers[header];
    });

    return lowerCasedHeaders;
  } else {
    return headers;
  }
}

function lowercasedHeaders(headersSchema, enableHeadersLowercase) {
  if (headersSchema && enableHeadersLowercase) {
    const properties = headersSchema.properties;
    Object.keys(properties).forEach((header) => {
      const property = properties[header];
      delete properties[header];
      properties[header.toLowerCase()] = property;
    });

    if (headersSchema.required && headersSchema.required.length) {
      headersSchema.required = headersSchema.required.map((header) => {
        return header.toLowerCase();
      });
    }
  }

  return headersSchema;
}

function toOpenapiValidationError(error) {
  const validationError = {
    path: "instance" + error.instancePath,
    errorCode: `${error.keyword}.openapi.requestValidation`,
    message: error.message,
    location: error.location,
  };

  if (error.keyword === "$ref") {
    delete validationError.errorCode;
    validationError.schema = { $ref: error.params.ref };
  }

  if (error.params.missingProperty) {
    validationError.path += "/" + error.params.missingProperty;
  }

  validationError.path = validationError.path.replace(
    error.location === "body" ? /^instance\/body\/?/ : /^instance\/?/,
    ""
  );
  validationError.path = validationError.path.replace(/\//g, ".");

  if (!validationError.path) {
    // @ts-ignore
    delete validationError.path;
  }

  return stripBodyInfo(validationError);
}

function stripBodyInfo(error) {
  if (error.location === "body") {
    if (typeof error.path === "string") {
      error.path = error.path.replace(/^body\./, "");
    } else {
      // Removing to avoid breaking clients that are expecting strings.
      delete error.path;
    }

    error.message = error.message.replace(/^instance\.body\./, "instance.");
  }

  return error;
}

function withAddedLocation(location, errors) {
  errors.forEach((error) => {
    error.location = location;
  });

  return errors;
}

function resolveAndSanitizeRequestBodySchema(requestBodySchema, v) {
  let resolved;
  let copied;

  if ("properties" in requestBodySchema) {
    const schema = requestBodySchema;
    Object.keys(schema.properties).forEach((property) => {
      let prop = schema.properties[property];
      prop = sanitizeReadonlyPropertiesFromRequired(prop);
      if (!prop.hasOwnProperty("$ref") && !prop.hasOwnProperty("items")) {
        prop = resolveAndSanitizeRequestBodySchema(prop, v);
      }
    });
    requestBodySchema =
      sanitizeReadonlyPropertiesFromRequired(requestBodySchema);
  } else if ("$ref" in requestBodySchema) {
    resolved = v.getSchema(requestBodySchema.$ref);
    if (resolved && resolved.schema) {
      copied = JSON.parse(JSON.stringify(resolved.schema));
      copied = sanitizeReadonlyPropertiesFromRequired(copied);
      copied = resolveAndSanitizeRequestBodySchema(copied, v);
      requestBodySchema = copied;
    }
  } else if ("items" in requestBodySchema) {
    if ("$ref" in requestBodySchema.items) {
      resolved = v.getSchema(requestBodySchema.items.$ref);
      if (resolved && resolved.schema) {
        copied = JSON.parse(JSON.stringify(resolved.schema));
        copied = sanitizeReadonlyPropertiesFromRequired(copied);
        copied = resolveAndSanitizeRequestBodySchema(copied, v);
        requestBodySchema.items = copied;
      }
    }
  } else if ("allOf" in requestBodySchema) {
    requestBodySchema.allOf = requestBodySchema.allOf.map((val) => {
      val = sanitizeReadonlyPropertiesFromRequired(val);
      return resolveAndSanitizeRequestBodySchema(val, v);
    });
  } else if ("oneOf" in requestBodySchema) {
    requestBodySchema.oneOf = requestBodySchema.oneOf.map((val) => {
      val = sanitizeReadonlyPropertiesFromRequired(val);
      return resolveAndSanitizeRequestBodySchema(val, v);
    });
  } else if ("anyOf" in requestBodySchema) {
    requestBodySchema.anyOf = requestBodySchema.anyOf.map((val) => {
      val = sanitizeReadonlyPropertiesFromRequired(val);
      return resolveAndSanitizeRequestBodySchema(val, v);
    });
  }
  return requestBodySchema;
}

function sanitizeReadonlyPropertiesFromRequired(schema) {
  if ("properties" in schema && "required" in schema) {
    const readOnlyProps = Object.keys(schema.properties).map((key) => {
      const prop = schema.properties[key];
      if (prop && "readOnly" in prop) {
        if (prop.readOnly === true) {
          return key;
        }
      }
      return;
    });
    readOnlyProps
      .filter((i) => i !== undefined)
      .forEach((value) => {
        const index = schema.required.indexOf(value);
        if (index !== -1) {
          schema.required.splice(index, 1);
        }
      });
  }
  return schema;
}

function recursiveTransformOpenAPIV3Definitions(object) {
  // Transformations //
  // OpenAPIV3 nullable
  if (object.nullable === true) {
    if (object.enum) {
      // Enums can not be null with type null
      object.oneOf = [
        { type: "null" },
        {
          type: object.type,
          enum: object.enum,
        },
      ];
      delete object.type;
      delete object.enum;
    } else if (object.type) {
      object.type = [object.type, "null"];
    } else if (object.allOf) {
      object.anyOf = [{ allOf: object.allOf }, { type: "null" }];
      delete object.allOf;
    } else if (object.oneOf || object.anyOf) {
      const arr = object.oneOf || object.anyOf;
      arr.push({ type: "null" });
    }

    delete object.nullable;
  }
  Object.keys(object).forEach((attr) => {
    if (typeof object[attr] === "object" && object[attr] !== null) {
      recursiveTransformOpenAPIV3Definitions(object[attr]);
    } else if (Array.isArray(object[attr])) {
      object[attr].forEach((obj) =>
        recursiveTransformOpenAPIV3Definitions(obj)
      );
    }
  });
}

function transformOpenAPIV3Definitions(schema) {
  if (typeof schema !== "object") {
    return schema;
  }
  const res = JSON.parse(JSON.stringify(schema));
  recursiveTransformOpenAPIV3Definitions(res);
  return res;
}

function getHeaderValue(requestHeaders, header) {
  const matchingHeaders = Object.keys(requestHeaders || {}).filter(
    (key) => key.toLowerCase() === header.toLowerCase()
  );
  return (requestHeaders || {})[matchingHeaders[0]];
}

function generateOASValidationCode(oasPath, generatedCodePath) {
  const dir = generatedCodePath;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);

  const oas = deref(yaml.load(fs.readFileSync(oasPath, "utf-8")));

  for (const resource of Object.keys(oas.paths)) {
    for (const method of Object.keys(oas.paths[resource])) {
      const oasFileNameFromPath = oasPath.split("/").pop().replace(".yaml", "");
      const fileName = `${oasFileNameFromPath}_${resource.replace(
        /\//g,
        ""
      )}_${method}.js`;

      const endpoint = oas.paths[resource][method];
      const validator = new OpenAPIRequestValidator(
        endpoint,
        dir,
        fileName.replace(".js", "")
      );

      const serializedValidator = serialize(validator, { unsafe: true });

      const helperFunctions = [
        getSchemaForMediaType,
        withAddedLocation,
        getHeaderValue,
        lowercaseRequestHeaders,
        stripBodyInfo,
      ];

      let output = `
        const contentTypeParser = require('content-type');
        const _validator = ${serializedValidator};
        try {
          _validator.requestBodyValidators = {
            'application/json': require(__filename.replace(/\.js$/, '_requestBodyValidators_applicationjson.js'))
          }
        } catch {}
        try {
          _validator.validateBody = require(__filename.replace(/\.js$/, '_validateBody.js'))
        } catch {}
        try {
          _validator.validateFormData = require(__filename.replace(/\.js$/, '_validateFormData.js'))
        } catch {}
        try {
          _validator.validateHeaders = require(__filename.replace(/\.js$/, '_validateHeaders.js'))
        } catch {}
        try {
          _validator.validatePath = require(__filename.replace(/\.js$/, '_validatePath.js'))
        } catch {}
        try {
          _validator.validateQuery = require(__filename.replace(/\.js$/, '_validateQuery.js'))
        } catch {}
      `;
      helperFunctions.forEach((fn) => {
        output += fn.toString();
      });
      output += `module.exports=${validateRequest.toString()}`;

      const file = path.join(dir, fileName);
      fs.writeFileSync(file, output, "utf-8");
    }
  }
}

module.exports = generateOASValidationCode;
