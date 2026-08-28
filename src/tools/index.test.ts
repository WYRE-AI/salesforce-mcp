import { describe, it, expect, vi } from "vitest";
import type { Connection } from "jsforce";
import { SALESFORCE_TOOLS, callTool, type ToolCallContext } from "./index.js";

function makeCtx(overrides: Partial<Connection> = {}): ToolCallContext {
  return { connection: overrides as Connection };
}

describe("SALESFORCE_TOOLS", () => {
  it("declares exactly the 6 in-scope tools with the salesforce_ prefix", () => {
    const names = SALESFORCE_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "salesforce_search_objects",
      "salesforce_describe_object",
      "salesforce_query_records",
      "salesforce_aggregate_query",
      "salesforce_dml_records",
      "salesforce_search_all",
    ]);
  });

  it("marks each tool's primary argument as required", () => {
    for (const tool of SALESFORCE_TOOLS) {
      expect(tool.inputSchema.required?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("callTool — dispatch", () => {
  it("throws Unknown tool for an unregistered name", async () => {
    await expect(callTool("salesforce_nonexistent", {}, makeCtx())).rejects.toThrow(
      /Unknown tool: salesforce_nonexistent/,
    );
  });
});

describe("salesforce_search_objects", () => {
  it("calls describeGlobal and filters + shapes matches by name/label substring, case-insensitively", async () => {
    const describeGlobal = vi.fn().mockResolvedValue({
      sobjects: [
        {
          name: "Account",
          label: "Account",
          custom: false,
          queryable: true,
          createable: true,
          updateable: true,
          deletable: true,
        },
        {
          name: "AccountHistory",
          label: "Account History",
          custom: false,
          queryable: true,
          createable: false,
          updateable: false,
          deletable: false,
        },
        {
          name: "Contact",
          label: "Contact",
          custom: false,
          queryable: true,
          createable: true,
          updateable: true,
          deletable: true,
        },
      ],
    });

    const result = (await callTool(
      "salesforce_search_objects",
      { pattern: "ACCOUNT" },
      makeCtx({ describeGlobal }),
    )) as { pattern: string; matchCount: number; objects: unknown[] };

    expect(describeGlobal).toHaveBeenCalledTimes(1);
    expect(describeGlobal).toHaveBeenCalledWith();
    expect(result.pattern).toBe("account");
    expect(result.matchCount).toBe(2);
    expect(result.objects).toEqual([
      {
        name: "Account",
        label: "Account",
        custom: false,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
      },
      {
        name: "AccountHistory",
        label: "Account History",
        custom: false,
        queryable: true,
        createable: false,
        updateable: false,
        deletable: false,
      },
    ]);
  });

  it("throws when pattern is missing/empty", async () => {
    await expect(callTool("salesforce_search_objects", {}, makeCtx())).rejects.toThrow(
      /pattern is required/,
    );
    await expect(
      callTool("salesforce_search_objects", { pattern: "" }, makeCtx()),
    ).rejects.toThrow(/pattern is required/);
  });
});

describe("salesforce_describe_object", () => {
  it("calls connection.sobject(name).describe() and shapes fields/picklists/child relationships", async () => {
    const describe = vi.fn().mockResolvedValue({
      name: "Account",
      label: "Account",
      custom: false,
      fields: [
        {
          name: "Industry",
          label: "Industry",
          type: "picklist",
          length: 0,
          nillable: true,
          updateable: true,
          createable: true,
          defaultValue: null,
          picklistValues: [
            { value: "Technology", label: "Technology", active: true },
            { value: "Retail", label: "Retail", active: false },
          ],
          referenceTo: [],
        },
        {
          name: "Name",
          label: "Account Name",
          type: "string",
          length: 255,
          nillable: false,
          updateable: true,
          createable: true,
          defaultValue: undefined,
          picklistValues: [],
          referenceTo: [],
        },
        {
          name: "OwnerId",
          label: "Owner",
          type: "reference",
          length: 18,
          nillable: false,
          updateable: true,
          createable: true,
          defaultValue: undefined,
          picklistValues: [],
          referenceTo: ["User"],
        },
      ],
      childRelationships: [
        { relationshipName: "Contacts", childSObject: "Contact", field: "AccountId" },
      ],
    });
    const sobject = vi.fn().mockReturnValue({ describe });

    const result = (await callTool(
      "salesforce_describe_object",
      { objectName: "Account" },
      makeCtx({ sobject }),
    )) as {
      name: string;
      fields: Array<{ name: string; picklistValues?: unknown; referenceTo?: unknown }>;
      childRelationships: unknown[];
    };

    expect(sobject).toHaveBeenCalledWith("Account");
    expect(describe).toHaveBeenCalledTimes(1);
    expect(result.name).toBe("Account");
    expect(result.fields[0]!.picklistValues).toEqual([
      { value: "Technology", label: "Technology", active: true },
      { value: "Retail", label: "Retail", active: false },
    ]);
    // Empty picklistValues/referenceTo arrays collapse to undefined.
    expect(result.fields[1]!.picklistValues).toBeUndefined();
    expect(result.fields[1]!.referenceTo).toBeUndefined();
    // Non-empty referenceTo is passed through.
    expect(result.fields[2]!.referenceTo).toEqual(["User"]);
    expect(result.childRelationships).toEqual([
      { relationshipName: "Contacts", childSObject: "Contact", field: "AccountId" },
    ]);
  });

  it("throws when objectName is missing/empty", async () => {
    await expect(callTool("salesforce_describe_object", {}, makeCtx())).rejects.toThrow(
      /objectName is required/,
    );
  });
});

describe("salesforce_query_records", () => {
  it("passes the raw SOQL to connection.query and returns totalSize/done/records/nextRecordsUrl", async () => {
    const query = vi.fn().mockResolvedValue({
      totalSize: 2,
      done: false,
      nextRecordsUrl: "/services/data/v60.0/query/01gxx-2000",
      records: [{ Id: "001", Name: "Acme" }],
    });

    const soql = "SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 100";
    const result = await callTool(
      "salesforce_query_records",
      { soql },
      makeCtx({ query }),
    );

    expect(query).toHaveBeenCalledWith(soql);
    expect(result).toEqual({
      totalSize: 2,
      done: false,
      nextRecordsUrl: "/services/data/v60.0/query/01gxx-2000",
      records: [{ Id: "001", Name: "Acme" }],
    });
  });

  it("throws when soql is missing/empty", async () => {
    await expect(callTool("salesforce_query_records", {}, makeCtx())).rejects.toThrow(
      /soql is required/,
    );
  });
});

describe("salesforce_aggregate_query", () => {
  it("passes the raw SOQL to connection.query and returns totalSize/done/records (no nextRecordsUrl)", async () => {
    const query = vi.fn().mockResolvedValue({
      totalSize: 3,
      done: true,
      records: [{ StageName: "Closed Won", expr0: 5 }],
    });

    const soql = "SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName";
    const result = await callTool(
      "salesforce_aggregate_query",
      { soql },
      makeCtx({ query }),
    );

    expect(query).toHaveBeenCalledWith(soql);
    expect(result).toEqual({
      totalSize: 3,
      done: true,
      records: [{ StageName: "Closed Won", expr0: 5 }],
    });
  });

  it("throws when soql is missing/empty", async () => {
    await expect(callTool("salesforce_aggregate_query", {}, makeCtx())).rejects.toThrow(
      /soql is required/,
    );
  });
});

describe("salesforce_dml_records", () => {
  it("insert: calls sobject(objectName).create(records)", async () => {
    const create = vi.fn().mockResolvedValue([{ id: "001A", success: true, errors: [] }]);
    const sobject = vi.fn().mockReturnValue({ create });
    const records = [{ Name: "New Co" }];

    const result = await callTool(
      "salesforce_dml_records",
      { operation: "insert", objectName: "Account", records },
      makeCtx({ sobject }),
    );

    expect(sobject).toHaveBeenCalledWith("Account");
    expect(create).toHaveBeenCalledWith(records);
    expect(result).toEqual({
      operation: "insert",
      objectName: "Account",
      results: [{ id: "001A", success: true, errors: [] }],
    });
  });

  it("update: calls sobject(objectName).update(records) when every record has an Id", async () => {
    const update = vi.fn().mockResolvedValue([{ id: "001A", success: true, errors: [] }]);
    const sobject = vi.fn().mockReturnValue({ update });
    const records = [{ Id: "001A", Name: "Renamed Co" }];

    const result = await callTool(
      "salesforce_dml_records",
      { operation: "update", objectName: "Account", records },
      makeCtx({ sobject }),
    );

    expect(update).toHaveBeenCalledWith(records);
    expect(result).toMatchObject({ operation: "update", objectName: "Account" });
  });

  it("update: throws (and never calls the API) when a record is missing Id", async () => {
    const update = vi.fn();
    const sobject = vi.fn().mockReturnValue({ update });

    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "update", objectName: "Account", records: [{ Name: "No Id" }] },
        makeCtx({ sobject }),
      ),
    ).rejects.toThrow(/update requires every record to have an "Id" field \(missing at index 0\)/);
    expect(update).not.toHaveBeenCalled();
  });

  it("delete: calls sobject(objectName).destroy(ids) built from record Ids", async () => {
    const destroy = vi.fn().mockResolvedValue([{ id: "001A", success: true, errors: [] }]);
    const sobject = vi.fn().mockReturnValue({ destroy });

    const result = await callTool(
      "salesforce_dml_records",
      { operation: "delete", objectName: "Account", records: [{ Id: "001A" }, { Id: "001B" }] },
      makeCtx({ sobject }),
    );

    expect(destroy).toHaveBeenCalledWith(["001A", "001B"]);
    expect(result).toMatchObject({ operation: "delete", objectName: "Account" });
  });

  it("delete: throws (and never calls the API) when a record is missing Id", async () => {
    const destroy = vi.fn();
    const sobject = vi.fn().mockReturnValue({ destroy });

    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "delete", objectName: "Account", records: [{ Id: "001A" }, { Name: "no id" }] },
        makeCtx({ sobject }),
      ),
    ).rejects.toThrow(/delete requires every record to have an "Id" field/);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("upsert: calls sobject(objectName).upsert(records, externalIdField)", async () => {
    const upsert = vi.fn().mockResolvedValue([{ id: "001A", success: true, created: true, errors: [] }]);
    const sobject = vi.fn().mockReturnValue({ upsert });
    const records = [{ External_Id__c: "EXT-1", Name: "Upserted Co" }];

    const result = await callTool(
      "salesforce_dml_records",
      { operation: "upsert", objectName: "Account", records, externalIdField: "External_Id__c" },
      makeCtx({ sobject }),
    );

    expect(upsert).toHaveBeenCalledWith(records, "External_Id__c");
    expect(result).toEqual({
      operation: "upsert",
      objectName: "Account",
      externalIdField: "External_Id__c",
      results: [{ id: "001A", success: true, created: true, errors: [] }],
    });
  });

  it("upsert: throws (and never calls the API) when externalIdField is missing", async () => {
    const upsert = vi.fn();
    const sobject = vi.fn().mockReturnValue({ upsert });

    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "upsert", objectName: "Account", records: [{ Name: "x" }] },
        makeCtx({ sobject }),
      ),
    ).rejects.toThrow(/upsert requires externalIdField to identify match key/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("throws on an unknown operation without touching connection.sobject", async () => {
    const sobject = vi.fn();
    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "frobnicate", objectName: "Account", records: [{ Id: "1" }] },
        makeCtx({ sobject }),
      ),
    ).rejects.toThrow(/Unknown operation: frobnicate/);
  });

  it("throws when objectName is missing", async () => {
    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "insert", records: [{ Name: "x" }] },
        makeCtx(),
      ),
    ).rejects.toThrow(/objectName is required/);
  });

  it("throws when records is missing or empty", async () => {
    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "insert", objectName: "Account", records: [] },
        makeCtx(),
      ),
    ).rejects.toThrow(/records must be a non-empty array/);
    await expect(
      callTool(
        "salesforce_dml_records",
        { operation: "insert", objectName: "Account" },
        makeCtx(),
      ),
    ).rejects.toThrow(/records must be a non-empty array/);
  });
});

describe("salesforce_search_all", () => {
  it("passes the raw SOSL to connection.search and returns searchRecordCount + searchRecords", async () => {
    const search = vi.fn().mockResolvedValue({
      searchRecords: [{ Id: "001A", Name: "Acme Corp" }],
    });

    const sosl = "FIND {acme corp} IN ALL FIELDS RETURNING Account(Id,Name)";
    const result = await callTool("salesforce_search_all", { sosl }, makeCtx({ search }));

    expect(search).toHaveBeenCalledWith(sosl);
    expect(result).toEqual({
      searchRecordCount: 1,
      searchRecords: [{ Id: "001A", Name: "Acme Corp" }],
    });
  });

  it("defaults to an empty array when searchRecords is absent", async () => {
    const search = vi.fn().mockResolvedValue({});
    const result = await callTool(
      "salesforce_search_all",
      { sosl: "FIND {x} IN ALL FIELDS RETURNING Account(Id)" },
      makeCtx({ search }),
    );
    expect(result).toEqual({ searchRecordCount: 0, searchRecords: [] });
  });

  it("throws when sosl is missing/empty", async () => {
    await expect(callTool("salesforce_search_all", {}, makeCtx())).rejects.toThrow(
      /sosl is required/,
    );
  });
});
