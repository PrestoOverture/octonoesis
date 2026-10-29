// @ts-nocheck -- standalone eval fixture
export class Queue {
 private tail = Promise.resolve()
 add(job) {
  const result = this.tail.then(job)
  this.tail = Promise.resolve()
  return result
 }
}
