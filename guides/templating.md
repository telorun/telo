# Telo Template Modules: Developer Guide

In Telo, a "template" is fundamentally a parameterized Module. By defining a strict contract and utilizing CEL-YAML directives, you can create reusable, encapsulated components that dynamically generate resources based on provided inputs.

## 1. Creating the Template Contract (`kind: Kernel.Module`)

The `kind: Kernel.Module` manifest acts as the public interface for your template. It dictates exactly what inputs the template requires and what outputs it exposes to the consumer.

- **Naming:** The template's `metadata.name` must be a kebab-case slug.
- **Inputs:** Define `variables` (standard configuration) and `secrets` (sensitive data) using JSON Schema object properties.
- **Optionality:** To make an input optional, you must explicitly define it with `default: null`.
- **Outputs:** Map internal resource properties to public outputs using the `exports` dictionary and CEL expressions.

**Example: `template-contract.yaml`**

```yaml
kind: Kernel.Module
metadata:
  name: secure-storage-template
variables:
  type: object
  properties:
    bucketName:
      type: string
    enableReplication:
      type: boolean
      default: null
secrets:
  type: object
  properties:
    accessKey:
      type: string
exports:
  primaryEndpoint: ${{ resources.MainBucket.endpointUrl }}
```

## 2. Implementing the Template Resources

The resources inside your template must be explicitly bound to the module's namespace and can use the injected inputs to shape their configuration.

- **Namespace Binding:** You must set `metadata.module: <module-slug>` to bind the resource to your template.
- **Naming Rule:** Resource names (`metadata.name`) **must not** contain hyphens.
- **Dynamic Generation:** Use the `$eval` directive to explicitly evaluate expressions at compile time, allowing you to dynamically set values based on the module's `variables` or conditionally render blocks using `$if`.

**Example: `template-resources.yaml`**

```yaml
kind: Storage.Bucket
metadata:
  name: MainBucket
  module: secure-storage-template
spec:
  # Using $eval to dynamically compute the name at compile time
  name: $eval: ${{ variables.bucketName }}
  credentials: ${{ secrets.accessKey }}

  # Conditionally generating a property based on variables
  $if: variables.enableReplication == true
  $then:
    replicationRegion: "eu-west-1"
```

## 3. Using the Template (`kind: Kernel.Import`)

To use the template in another module (like your application's Root Module), you instantiate it using the `kind: Kernel.Import` resource. The import acts as a local proxy that fulfills the template's contract.

- **Instantiation:** The `kind: Kernel.Import` provides the required `variables` and `secrets`. Import aliases (`metadata.name`) must not contain hyphens.
- **Passing Environment Variables:** If you are instantiating the template within the **Root Module**, you can securely pass host environment variables to the template's secrets using the `env` object.
- **Accessing Exports:** Once instantiated, you can access the template's exported properties in your local resources using the `${{ imports.<ImportName>.<exportProperty> }}` syntax.

**Example: `main-app.yaml`**

```yaml
kind: Kernel.Module
metadata:
  name: my-root-application

---
kind: Kernel.Import
metadata:
  name: UserDataStorage
spec:
  source: secure-storage-template
  variables:
    bucketName: "prod-user-data"
    enableReplication: true
  secrets:
    # Injecting host environment variable (Root Module only)
    accessKey: ${{ env.STORAGE_ACCESS_KEY }}

---
kind: Http.Api
metadata:
  name: UserApi
spec:
  # Utilizing the exported property from the instantiated template
  storageUrl: ${{ imports.UserDataStorage.primaryEndpoint }}
```
