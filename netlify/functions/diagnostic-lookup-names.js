// TEMPORARY DIAGNOSTIC — delete this file once the real navigation property
// names are confirmed and fixed in the other two functions.
const { dataverseRequest } = require("./dataverse-client");

exports.handler = async () => {
  try {
    const qualifierRels = await dataverseRequest(
      "GET",
      `EntityDefinitions(LogicalName='cre5b_knowhashpositionqualifier')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName`
    );
    const responseRels = await dataverseRequest(
      "GET",
      `EntityDefinitions(LogicalName='cre5b_knowhashqualifierresponse')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        qualifierTableLookups: qualifierRels.value,
        responseTableLookups: responseRels.value,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
