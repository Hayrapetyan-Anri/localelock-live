const noopDecorator =
  () =>
  (...args) =>
    args[0];

export const Entity = noopDecorator;
export const Property = noopDecorator;
export const PrimaryKey = noopDecorator;
export const Index = noopDecorator;
export const Unique = noopDecorator;
export const ManyToOne = noopDecorator;
export const OneToMany = noopDecorator;
export const Embeddable = noopDecorator;
export const Embedded = noopDecorator;
export const Enum = noopDecorator;

export class Type {
  convertToDatabaseValue(value) {
    return value;
  }
  convertToJSValue(value) {
    return value;
  }
  getColumnType() {
    return 'json';
  }
}
export class JsonType extends Type {}

function unavailable(name) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(
          `@mikro-orm/core is not bundled in this deployment (${name} requested). LocaleLock Live uses ADK's InMemorySessionService; database-backed ADK sessions are not enabled.`,
        );
      },
    },
  );
}

export const LockMode = {
  NONE: 0,
  READ: 1,
  WRITE: 2,
  PESSIMISTIC_READ: 'pessimistic_read',
  PESSIMISTIC_WRITE: 'pessimistic_write',
  OPTIMISTIC: 'optimistic',
};
export const ReferenceKind = { SCALAR: 'scalar', MANY_TO_ONE: 'm:1', ONE_TO_MANY: '1:m' };
export const QueryOrder = { ASC: 'ASC', DESC: 'DESC' };

export const MikroORM = unavailable('MikroORM');
export const EntitySchema = unavailable('EntitySchema');
export const RequestContext = unavailable('RequestContext');
export default { Entity, Property, PrimaryKey, JsonType, Type, MikroORM };
