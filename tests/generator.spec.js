const generateOASValidationCode = require("../index");

beforeAll(() => {
  generateOASValidationCode(
    __dirname + "/../testdata/petstore.yaml",
    __dirname + "/../generated"
  );
});

test("header validation", () => {
  const validator = require("../generated/petstore_pets_get");
  const result = validator({
    path: "/pets",
    resource: "/pets",
    method: "get",
    headers: {},
  });
  expect(result).toEqual({
    status: 400,
    errors: [
      {
        errorCode: "required.openapi.requestValidation",
        location: "headers",
        message: "must have required property 'testheader'",
        path: "testheader",
      },
    ],
  });
});

test("query param validation", () => {
  const validator = require("../generated/petstore_pets_get");
  const result = validator({
    path: "/pets",
    resource: "/pets",
    method: "get",
    headers: {
      testheader: "abc",
    },
    query: {
      limit: 500,
    },
  });
  expect(result).toEqual({
    status: 400,
    errors: [
      {
        errorCode: "maximum.openapi.requestValidation",
        location: "query",
        message: "must be <= 100",
        path: "limit",
      },
    ],
  });
});

test("path param validation", () => {
  const validator = require("../generated/petstore_pets{petId}_get");
  const result = validator({
    path: "/pets/123",
    resource: "/pets/{petId}",
    method: "get",
    params: {
      petId: 123,
    },
  });
  expect(result).toEqual({
    status: 400,
    errors: [
      {
        errorCode: "type.openapi.requestValidation",
        location: "path",
        message: "must be string",
        path: "petId",
      },
    ],
  });
});

test("body validation", () => {
  const validator = require("../generated/petstore_pets_post");
  const result = validator({
    path: "/pets",
    resource: "/pets",
    method: "post",
    headers: {
      "content-type": "application/json",
    },
  });
  expect(result).toEqual({
    errors: [
      {
        location: "body",
        message:
          "request.body was not present in the request.  Is a body-parser being used?",
        schema: {
          properties: {
            id: {
              format: "int64",
              type: "integer",
            },
            name: {
              type: "string",
            },
            tag: {
              type: "string",
            },
          },
          required: ["id", "name"],
          type: "object",
        },
      },
    ],
    status: 400,
  });
});

test("valid request", () => {
  const validator = require("../generated/petstore_pets_post");
  const result = validator({
    path: "/pets",
    resource: "/pets",
    method: "post",
    headers: {
      "content-type": "application/json",
    },
    body: {
      id: 1,
      name: "abc",
    },
  });
  expect(result).toBe(undefined);
});
